// The input row: mic, textarea, send. Shared so the two surfaces can't drift on
// the mic's disabled/recording states, which are tied to the hook's lifecycle.

import { Send, Mic, Square } from "lucide-react";
import { useTranslation } from "react-i18next";

export default function Composer({
  input, setInput, onSubmit, onToggleMic, recording, loading, busy, heldBySpace, compact = false,
}: {
  input: string;
  setInput: (v: string) => void;
  onSubmit: () => void;
  onToggleMic: () => void;
  recording: boolean;
  loading: boolean;
  busy: boolean;
  heldBySpace: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const pad = compact ? "p-2.5" : "p-4";
  const size = compact ? 16 : 18;
  const btn = compact ? "p-2" : "p-2.5";

  return (
    <div className={`border-t border-neutral-200 ${pad} dark:border-neutral-700`}>
      {recording && (
        <div className={`mx-auto mb-2 flex items-center gap-2 text-red-500 ${compact ? "text-xs" : "max-w-2xl text-sm"}`}>
          <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />
          {t(heldBySpace ? "assistant.listeningHintSpace" : "assistant.listeningHint")}
        </div>
      )}
      <div className={`flex items-end gap-2 ${compact ? "" : "mx-auto max-w-2xl"}`}>
        <button
          onClick={onToggleMic}
          disabled={loading}
          className={`rounded-xl ${btn} text-white disabled:opacity-40 ${
            recording ? "bg-red-600 hover:bg-red-700" : "bg-neutral-500 hover:bg-neutral-600"
          }`}
          aria-label={recording ? t("assistant.stopRecording") : t("assistant.startVoice")}
          title={recording ? t("assistant.stopRecording") : t("assistant.talkHint")}
        >
          {recording ? <Square size={size} /> : <Mic size={size} />}
        </button>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSubmit(); }
          }}
          rows={1}
          disabled={recording}
          placeholder={recording ? t("assistant.listening") : t("assistant.inputPlaceholder")}
          className={`flex-1 resize-none rounded-xl border border-neutral-200 outline-none focus:border-blue-400 disabled:opacity-60 dark:border-neutral-600 dark:bg-neutral-800 ${
            compact ? "max-h-24 px-3 py-2 text-sm" : "max-h-40 px-4 py-2.5 text-sm"
          }`}
        />
        <button
          onClick={onSubmit}
          disabled={busy || !input.trim()}
          className={`rounded-xl bg-blue-600 ${btn} text-white hover:bg-blue-700 disabled:opacity-40`}
          aria-label={t("assistant.send")}
        >
          <Send size={size} />
        </button>
      </div>
    </div>
  );
}
