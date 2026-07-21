// The assistant's turn and voice lifecycle, shared by the two surfaces that run
// a conversation: the full Assistant page and the floating popup.
//
// This lives in a hook, not a component, because both surfaces must behave
// identically — the speech hold-back, the release-before-mic-opened race, the
// per-turn AbortController and the show_items de-duping are all load-bearing
// and a second copy would drift. The surfaces are views over this state; none
// of them should reimplement deliver().
//
// Only one surface is ever mounted at a time (the popup hides itself on the
// assistant page), so the window-level hold-to-talk listener can't double up.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { askAssistant, ChatMessage } from "../../lib/ai";
import { hasOpenAiKey } from "../../lib/settings";
import {
  startRecording, transcribe, speak, stopSpeaking, isSpeechSupported, isRecordingSupported, Recording,
} from "../../lib/voice";
import type { ItemRef } from "../../types";

/** A chat message plus the items the assistant chose to show alongside it.
 *  ai.ts strips everything but role/content before calling the API, so the
 *  extra field never reaches the model. */
export type UiMessage = ChatMessage & { items?: ItemRef[] };

/**
 * How long to wait for speech to begin before showing the reply anyway.
 * Generous: a slow synthesis round-trip should still get the timing right, and
 * this only exists so a pathological hang can't lose the text entirely.
 */
const SPEECH_START_TIMEOUT_MS = 10000;

export interface UseAssistantChat {
  messages: UiMessage[];
  /** Owned by App so navigating to an item and back doesn't wipe the conversation. */
  setMessages: (m: UiMessage[]) => void;
  /**
   * Whether hold-Space-to-talk is live. The page passes true; the popup passes
   * its open state, so holding Space while it's collapsed to a button doesn't
   * start a recording nobody can see.
   */
  spaceEnabled?: boolean;
}

export function useAssistantChat({ messages, setMessages, spaceEnabled = true }: UseAssistantChat) {
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);   // assistant thinking / transcribing
  const [status, setStatus] = useState("");
  const [recording, setRecording] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<Recording | null>(null);
  const startingRef = useRef(false);     // startRecording() is in flight
  const stopPendingRef = useRef(false);  // released before recording began
  // AbortController for the in-flight assistant turn, so the user can stop a
  // runaway model (or a hung Ollama load) instead of waiting on MAX_TOOL_ROUNDS.
  const abortRef = useRef<AbortController | null>(null);
  // Set while a finished reply is being held back waiting for speech to start.
  // Calling it prints the reply immediately; see deliver().
  const revealRef = useRef<(() => void) | null>(null);

  const voiceOutput = isSpeechSupported();

  // Stop any speech and release the mic when the surface goes away. Without
  // this, navigating away mid-recording (e.g. clicking a cited card) leaves the
  // MediaRecorder + getUserMedia stream alive and the mic indicator stuck on.
  // Aborting the in-flight turn also prevents a reply landing after unmount.
  useEffect(() => () => {
    stopSpeaking();
    revealRef.current?.();
    abortRef.current?.abort();
    recRef.current?.cancel();
    recRef.current = null;
  }, []);

  // Hold-to-talk: press and hold Space to record, release to send. Refs keep
  // the listener stable while always calling the latest closures (so stopMic
  // sees the current `messages`), which registering once with fresh functions
  // via deps would not guarantee.
  const startMicRef = useRef<() => void>(() => {});
  const stopMicRef = useRef<() => void>(() => {});
  startMicRef.current = () => void startMic();
  stopMicRef.current = () => void stopMic();
  const spaceHeld = useRef(false);
  // Mirrors spaceHeld for rendering: the hint has to name the right way to
  // stop, and a ref alone wouldn't re-render it.
  const [heldBySpace, setHeldBySpace] = useState(false);
  useEffect(() => {
    if (!spaceEnabled) return;
    // Don't hijack Space from text fields, buttons, or links — it must still
    // type a space or activate the focused control there.
    const isInteractive = (el: EventTarget | null) => {
      const n = el as HTMLElement | null;
      return !!n && (/^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(n.tagName) || n.isContentEditable);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || spaceHeld.current) return;
      if (isInteractive(e.target) || isInteractive(document.activeElement)) return;
      if (!isRecordingSupported()) return;
      e.preventDefault(); // Space would otherwise scroll the chat.
      spaceHeld.current = true;
      setHeldBySpace(true);
      startMicRef.current();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== "Space" || !spaceHeld.current) return;
      e.preventDefault();
      spaceHeld.current = false;
      setHeldBySpace(false);
      stopMicRef.current();
    };
    // Blur (e.g. app loses focus mid-hold) must release, or we'd never get keyup.
    const onBlur = () => { if (spaceHeld.current) { spaceHeld.current = false; setHeldBySpace(false); stopMicRef.current(); } };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      // Closing the popup mid-hold must release the key, or the next open
      // starts with spaceHeld stuck true and the first press does nothing.
      if (spaceHeld.current) { spaceHeld.current = false; setHeldBySpace(false); stopMicRef.current(); }
    };
  }, [spaceEnabled]);

  const busy = loading || recording;

  /** Core turn: append the user text, run the assistant, optionally speak the reply. */
  async function deliver(text: string, spoken: boolean) {
    const q = text.trim();
    if (!q) return;
    setError(null);
    const next: UiMessage[] = [...messages, { role: "user", content: q }];
    setMessages(next);
    setInput("");
    setLoading(true);
    setStatus(t("status.thinking"));
    // A fresh controller per turn. Aborting it cancels the in-flight fetch and
    // any pending round before it starts.
    const controller = new AbortController();
    abortRef.current = controller;
    // show_items can fire more than once in a turn (and once more from the
    // card-recovery round), so collect, de-dupe, and attach the whole set to
    // the reply once it arrives. Same key the cards render with.
    const shown: ItemRef[] = [];
    const seen = new Set<string>();
    try {
      const reply = await askAssistant(next, {
        onStatus: setStatus,
        signal: controller.signal,
        onItems: (items) => {
          for (const it of items) {
            const key = `${it.type}:${it.id}:${it.occurrenceStart ?? ""}`;
            if (seen.has(key)) continue;
            seen.add(key);
            shown.push(it);
          }
        },
      });
      const showReply = () =>
        setMessages([...next, {
          role: "assistant", content: reply, items: shown.length ? shown : undefined,
        }]);

      if (spoken && voiceOutput) {
        // Hold the text back until the voice actually starts. Natural voices
        // need a network round-trip to synthesise, so printing the reply on
        // arrival left it sitting on screen for a second or two of silence
        // before being read out — as if the app were reading it back to you.
        setSpeaking(true);
        setStatus(t("status.speaking"));
        await new Promise<void>((resolve) => {
          const release = () => { window.clearTimeout(timer); revealRef.current = null; resolve(); };
          // Backstop: never let a speech problem swallow the reply. voice.ts
          // guarantees onStart fires even when it can't speak, so this only
          // covers something pathological — but "reply never appears" is far
          // too high a price for a timing nicety.
          const timer = window.setTimeout(() => { showReply(); release(); }, SPEECH_START_TIMEOUT_MS);
          // Stopping mid-wait should show the text immediately, not strand it
          // until the backstop fires.
          revealRef.current = () => { showReply(); release(); };
          speak(reply, {
            onStart: () => { showReply(); release(); },
            onEnd: () => { setSpeaking(false); },
          });
        });
      } else {
        showReply();
      }
    } catch (e) {
      // A user cancel is not an error to surface — they asked for it.
      if ((e as Error)?.name === "AbortError" || controller.signal.aborted) {
        // Drop the cancelled user turn so it doesn't sit there with no reply.
        setMessages(next.slice(0, -1));
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      abortRef.current = null;
      setLoading(false);
    }
  }

  /** Cancel an in-flight assistant turn (Stop button). No-op if nothing running. */
  function stopAssistant() {
    abortRef.current?.abort();
  }

  function submitTyped() {
    if (busy || !input.trim()) return;
    void deliver(input, false);
  }

  /** Begin recording. No-op if already recording, starting, or busy. */
  async function startMic() {
    if (recRef.current || startingRef.current || loading) return;
    setError(null);
    if (!isRecordingSupported()) { setError(t("assistant.micUnavailable")); return; }
    // Voice input transcribes via OpenAI (Ollama can't), so it needs an OpenAI
    // key even when the text assistant is answering through Ollama.
    if (!hasOpenAiKey()) { setError(t("assistant.voiceNeedsKey")); return; }
    stopSpeaking();
    revealRef.current?.();
    setSpeaking(false);
    startingRef.current = true;
    stopPendingRef.current = false;
    try {
      const rec = await startRecording();
      // Push-to-talk released before the mic actually opened: there's no usable
      // audio, so discard it rather than leaving a recording no one can stop.
      if (stopPendingRef.current) {
        stopPendingRef.current = false;
        try { await rec.stop(); } catch { /* nothing to keep */ }
        return;
      }
      recRef.current = rec;
      setRecording(true);
    } catch (e) {
      setError(e instanceof Error ? t("assistant.micError", { message: e.message }) : t("assistant.micDenied"));
    } finally {
      startingRef.current = false;
    }
  }

  /** Stop recording → transcribe → send (spoken reply for voice turns). */
  async function stopMic() {
    // Released mid-startup: tell startMic to abort once the mic opens.
    if (startingRef.current && !recRef.current) { stopPendingRef.current = true; return; }
    const rec = recRef.current;
    if (!rec) return;
    recRef.current = null;
    setRecording(false);
    setLoading(true);
    setStatus(t("assistant.transcribing"));
    // The controller covers the transcription fetch; deliver() creates its own
    // for the chat phase. One ref so Stop works in both.
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const blob = await rec.stop();
      const text = await transcribe(blob, controller.signal);
      abortRef.current = null;
      setLoading(false);
      if (!text) { setError(t("assistant.notHeard")); return; }
      await deliver(text, true);
    } catch (e) {
      abortRef.current = null;
      setLoading(false);
      // User cancelled the transcription: don't surface it as an error.
      if (!((e as Error)?.name === "AbortError" || controller.signal.aborted)) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }

  /** Mic button: click to start recording, click again to stop. */
  function toggleMic() {
    if (recRef.current) void stopMic();
    else void startMic();
  }

  function stopVoice() {
    stopSpeaking();
    // Stopping the voice must never cost the text: if the reply is still being
    // held for speech to begin, show it now.
    revealRef.current?.();
    setSpeaking(false);
  }

  /**
   * Throw away an in-progress recording without transcribing it, and silence
   * any reply being read aloud.
   *
   * For a surface that can be dismissed while still mounted (the popup, which
   * collapses to a button): the unmount cleanup doesn't run, so without this a
   * recording started before the close keeps the mic open with nothing on
   * screen to stop it. An in-flight *text* turn is deliberately left alone —
   * its answer is still worth having when the window is reopened.
   */
  function cancelInput() {
    stopSpeaking();
    revealRef.current?.();
    setSpeaking(false);
    stopPendingRef.current = true;   // covers a start still in flight
    recRef.current?.cancel();
    recRef.current = null;
    setRecording(false);
  }

  /** Clear the conversation and any error, silencing a reply mid-sentence. */
  function clear() {
    setMessages([]);
    setError(null);
    stopVoice();
  }

  return {
    input, setInput,
    loading, status, recording, speaking, heldBySpace, error, setError, busy,
    voiceOutput,
    deliver, submitTyped, stopAssistant, toggleMic, stopVoice, cancelInput, clear,
  };
}
