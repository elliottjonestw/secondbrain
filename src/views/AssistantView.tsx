import { useEffect, useRef, useState } from "react";
import { Send, Sparkles, Trash2, Settings as SettingsIcon, Mic, Square, VolumeX } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslation } from "react-i18next";
import { askAssistant, ChatMessage } from "../lib/ai";
import { hasApiKey } from "../lib/settings";
import {
  startRecording, transcribe, speak, stopSpeaking, isSpeechSupported, isRecordingSupported, Recording,
} from "../lib/voice";
import { Button } from "../components/ui";
import { ItemRefCard, VIEW_FOR, targetFor } from "../components/ItemCard";
import type { GoTo, ItemRef } from "../types";

// Rendered from the catalog so the examples read naturally in each language
// rather than being English prompts shown to a Chinese speaker.
const SUGGESTION_KEYS = [
  "assistant.suggestion1", "assistant.suggestion2",
  "assistant.suggestion3", "assistant.suggestion4",
] as const;

/** A chat message plus the items the assistant chose to show alongside it.
 *  ai.ts strips everything but role/content before calling the API, so the
 *  extra field never reaches the model. */
export type UiMessage = ChatMessage & { items?: ItemRef[] };

export default function AssistantView({
  messages, setMessages, goTo,
}: {
  // Owned by App so navigating to an item and back doesn't wipe the conversation.
  messages: UiMessage[];
  setMessages: (m: UiMessage[]) => void;
  goTo: GoTo;
}) {
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);   // assistant thinking / transcribing
  const [status, setStatus] = useState("");
  const [recording, setRecording] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyed, setKeyed] = useState(hasApiKey());
  const recRef = useRef<Recording | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const voiceOutput = isSpeechSupported();

  useEffect(() => { setKeyed(hasApiKey()); }, []);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);
  // Stop any speech when leaving the page.
  useEffect(() => () => stopSpeaking(), []);

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
    // show_items can fire more than once in a turn (and once more from the
    // card-recovery round), so collect, de-dupe, and attach the whole set to
    // the reply once it arrives. Same key the cards render with.
    const shown: ItemRef[] = [];
    const seen = new Set<string>();
    try {
      const reply = await askAssistant(next, {
        onStatus: setStatus,
        onItems: (items) => {
          for (const it of items) {
            const key = `${it.type}:${it.id}:${it.occurrenceStart ?? ""}`;
            if (seen.has(key)) continue;
            seen.add(key);
            shown.push(it);
          }
        },
      });
      setMessages([...next, { role: "assistant", content: reply, items: shown.length ? shown : undefined }]);
      if (spoken && voiceOutput) {
        setSpeaking(true);
        speak(reply);
        // Poll speechSynthesis to clear the speaking indicator when done.
        const timer = window.setInterval(() => {
          if (!window.speechSynthesis.speaking) { setSpeaking(false); window.clearInterval(timer); }
        }, 300);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function submitTyped() {
    if (busy || !input.trim()) return;
    void deliver(input, false);
  }

  /** Mic button: click to start recording, click again to stop → transcribe → send. */
  async function toggleMic() {
    if (recording) {
      const rec = recRef.current;
      recRef.current = null;
      setRecording(false);
      if (!rec) return;
      setLoading(true);
      setStatus(t("assistant.transcribing"));
      try {
        const blob = await rec.stop();
        const text = await transcribe(blob);
        setLoading(false);
        if (!text) { setError(t("assistant.notHeard")); return; }
        await deliver(text, true); // spoken reply for voice turns
      } catch (e) {
        setLoading(false);
        setError(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    // start
    if (loading) return;
    setError(null);
    if (!isRecordingSupported()) {
      setError(
        t("assistant.micUnavailable"),
      );
      return;
    }
    stopSpeaking();
    setSpeaking(false);
    try {
      recRef.current = await startRecording();
      setRecording(true);
    } catch (e) {
      setError(
        e instanceof Error
          ? t("assistant.micError", { message: e.message })
          : t("assistant.micDenied"),
      );
    }
  }

  function stopVoice() {
    stopSpeaking();
    setSpeaking(false);
  }

  if (!keyed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <Sparkles size={40} className="text-blue-500" />
        <div>
          <h1 className="text-xl font-bold">{t("assistant.title")}</h1>
          <p className="mt-1 max-w-sm text-sm text-neutral-500">
{t("assistant.needKey")}
          </p>
        </div>
        <Button variant="primary" onClick={() => goTo("settings")}>
          <span className="flex items-center gap-1.5"><SettingsIcon size={15} /> {t("assistant.openSettings")}</span>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-neutral-200 px-6 py-3 dark:border-neutral-700">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Sparkles size={18} className="text-blue-500" /> {t("assistant.title")}
        </h1>
        <div className="flex items-center gap-3">
          {speaking && (
            <Button variant="ghost" onClick={stopVoice}>
              <span className="flex items-center gap-1.5"><VolumeX size={14} /> {t("assistant.stopSpeaking")}</span>
            </Button>
          )}
          <span className="text-xs text-neutral-400">{t("assistant.tagline")}</span>
          {messages.length > 0 && (
            <Button variant="ghost" onClick={() => { setMessages([]); setError(null); stopVoice(); }}>
              <span className="flex items-center gap-1.5"><Trash2 size={14} /> {t("assistant.clear")}</span>
            </Button>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-2xl space-y-4">
          {messages.length === 0 && (
            <div className="pt-8 text-center">
              <p className="mb-4 text-sm text-neutral-400">
{t("assistant.emptyPrompt")}
              </p>
              <div className="mx-auto flex max-w-md flex-col gap-2">
                {SUGGESTION_KEYS.map((k) => t(k)).map((s) => (
                  <button
                    key={s}
                    onClick={() => deliver(s, false)}
                    className="rounded-lg border border-neutral-200 px-3 py-2 text-left text-sm hover:border-blue-400 hover:bg-blue-50 dark:border-neutral-700 dark:hover:bg-blue-900/20"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i}>
              <div className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${
                    m.role === "user"
                      ? "bg-blue-600 text-white"
                      : "bg-white text-neutral-800 shadow-sm ring-1 ring-neutral-200 dark:bg-neutral-800 dark:text-neutral-100 dark:ring-neutral-700"
                  }`}
                >
                  {m.role === "assistant" ? (
                    <div className="prose prose-sm max-w-none dark:prose-invert">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                    </div>
                  ) : (
                    <span className="whitespace-pre-wrap">{m.content}</span>
                  )}
                </div>
              </div>
              {/* Outside the bubble so the cards get the full column width.
                  A recurring series shares one id, so the occurrence is part of the key. */}
              {m.items && m.items.length > 0 && (
                <div className="mt-2 space-y-1">
                  {m.items.map((it) => (
                    <ItemRefCard
                      key={`${it.type}:${it.id}:${it.occurrenceStart ?? ""}`}
                      item={it}
                      onOpen={(r) => goTo(VIEW_FOR[r.type], targetFor(r))}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-2xl bg-white px-4 py-2.5 text-sm text-neutral-400 shadow-sm ring-1 ring-neutral-200 dark:bg-neutral-800 dark:ring-neutral-700">
                <Sparkles size={14} className="animate-pulse text-blue-400" /> {status}
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
              {error}
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-neutral-200 p-4 dark:border-neutral-700">
        {recording && (
          <div className="mx-auto mb-2 flex max-w-2xl items-center gap-2 text-sm text-red-500">
            <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />
            {t("assistant.listeningHint")}
          </div>
        )}
        <div className="mx-auto flex max-w-2xl items-end gap-2">
          <button
            onClick={() => void toggleMic()}
            disabled={loading}
            className={`rounded-xl p-2.5 text-white disabled:opacity-40 ${
              recording ? "bg-red-600 hover:bg-red-700" : "bg-neutral-500 hover:bg-neutral-600"
            }`}
            aria-label={recording ? t("assistant.stopRecording") : t("assistant.startVoice")}
            title={recording ? t("assistant.stopRecording") : t("assistant.talk")}
          >
            {recording ? <Square size={18} /> : <Mic size={18} />}
          </button>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitTyped(); }
            }}
            rows={1}
            disabled={recording}
            placeholder={recording ? t("assistant.listening") : t("assistant.inputPlaceholder")}
            className="max-h-40 flex-1 resize-none rounded-xl border border-neutral-200 px-4 py-2.5 text-sm outline-none focus:border-blue-400 disabled:opacity-60 dark:border-neutral-600 dark:bg-neutral-800"
          />
          <button
            onClick={submitTyped}
            disabled={busy || !input.trim()}
            className="rounded-xl bg-blue-600 p-2.5 text-white hover:bg-blue-700 disabled:opacity-40"
            aria-label={t("assistant.send")}
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
