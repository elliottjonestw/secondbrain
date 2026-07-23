// A mic button that dictates into a text field: click to record, click again to
// stop, transcribe, and hand the text back.
//
// Deliberately owns its whole record → transcribe lifecycle rather than exposing
// one, because unlike the assistant there's no second surface to share it with —
// the button *is* the reusable unit, and a caller that had to drive startMic /
// stopMic itself would be a second copy of the guards below.
//
// The caller decides where the text lands: onStart() returns an anchor (any
// value — the note editor uses a placeholder token it has just inserted at the
// caret), which comes back to onResult alongside the transcript. `null` text
// means nothing usable was heard, so the anchor should be cleaned up.

import { useEffect, useRef, useState } from "react";
import { Mic, Square, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { startRecording, transcribe, isRecordingSupported, Recording } from "../lib/voice";
import { hasOpenAiKey } from "../lib/settings";

interface Props<T> {
  /** Called when recording actually begins; returns the anchor for onResult. */
  onStart: () => T;
  /** The transcript for that anchor, or null if nothing usable came back. */
  onResult: (anchor: T, text: string | null) => void;
  onError: (message: string) => void;
  className?: string;
}

export default function DictateButton<T>({ onStart, onResult, onError, className }: Props<T>) {
  const { t } = useTranslation();
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const recRef = useRef<Recording | null>(null);
  // Same pair of guards the assistant needs: getUserMedia is async, so a second
  // click can land before the mic is open — without these it either starts a
  // recording nothing can stop, or opens a second one behind the first.
  const startingRef = useRef(false);
  const stopPendingRef = useRef(false);
  const anchorRef = useRef<T | null>(null);

  // Releasing the mic on unmount is what stops the recording indicator sticking
  // on when the editor is closed mid-dictation.
  useEffect(() => () => {
    recRef.current?.cancel();
    recRef.current = null;
  }, []);

  async function start() {
    if (recRef.current || startingRef.current || transcribing) return;
    if (!isRecordingSupported()) { onError(t("assistant.micUnavailable")); return; }
    // Transcription runs on OpenAI.
    if (!hasOpenAiKey()) { onError(t("assistant.voiceNeedsKey")); return; }
    startingRef.current = true;
    stopPendingRef.current = false;
    try {
      const rec = await startRecording();
      // Stopped before the mic opened: there's no usable audio, so drop it
      // rather than leave a recording the UI thinks isn't running.
      if (stopPendingRef.current) {
        stopPendingRef.current = false;
        try { await rec.stop(); } catch { /* nothing to keep */ }
        return;
      }
      recRef.current = rec;
      anchorRef.current = onStart();
      setRecording(true);
    } catch (e) {
      onError(e instanceof Error ? t("assistant.micError", { message: e.message }) : t("assistant.micDenied"));
    } finally {
      startingRef.current = false;
    }
  }

  async function stop() {
    if (startingRef.current && !recRef.current) { stopPendingRef.current = true; return; }
    const rec = recRef.current;
    if (!rec) return;
    recRef.current = null;
    const anchor = anchorRef.current as T;
    anchorRef.current = null;
    setRecording(false);
    setTranscribing(true);
    try {
      const text = await transcribe(await rec.stop());
      onResult(anchor, text || null);
      if (!text) onError(t("assistant.notHeard"));
    } catch (e) {
      onResult(anchor, null);
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setTranscribing(false);
    }
  }

  const label = recording ? t("assistant.stopRecording")
    : transcribing ? t("assistant.transcribing")
    : t("notes.md.dictate");

  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={transcribing}
      // Keep the textarea's selection: mousedown would blur it first, and the
      // caret is exactly what decides where the transcript lands.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => { onError(""); void (recording ? stop() : start()); }}
      className={`rounded-full border p-2 shadow-sm transition-colors disabled:opacity-60 ${
        recording
          ? "animate-pulse border-red-300 bg-red-50 text-red-600 dark:border-red-800 dark:bg-red-950 dark:text-red-400"
          : "border-neutral-200 bg-white text-neutral-500 hover:text-neutral-800 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-300 dark:hover:text-neutral-100"
      } ${className ?? ""}`}
    >
      {transcribing ? <Loader2 size={15} className="animate-spin" />
        : recording ? <Square size={15} fill="currentColor" />
        : <Mic size={15} />}
    </button>
  );
}
