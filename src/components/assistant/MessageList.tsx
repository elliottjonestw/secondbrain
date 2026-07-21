// The scrolling transcript: bubbles, the item cards the assistant cited, the
// thinking row and the error box. Shared by the Assistant page and the popup so
// a card renders identically in both — in particular the key, which includes
// the occurrence: a recurring series shares one id across occurrences, and
// keying on id alone collapses them into a single card.

import { useEffect, useRef, ReactNode } from "react";
import { Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslation } from "react-i18next";
import { Button } from "../ui";
import { ItemRefCard, VIEW_FOR, targetFor } from "../ItemCard";
import type { GoTo } from "../../types";
import type { UiMessage } from "./useAssistantChat";

export default function MessageList({
  messages, goTo, loading, status, error, onStop, empty, compact = false,
}: {
  messages: UiMessage[];
  goTo: GoTo;
  loading: boolean;
  status: string;
  error: string | null;
  onStop: () => void;
  /** Shown in place of the transcript when there are no messages yet. */
  empty?: ReactNode;
  /** Tighter padding and no centred column, for the popup. */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  return (
    // min-h-0 so this actually shrinks and scrolls inside the popup's
    // max-height column instead of pushing the composer off-screen.
    <div ref={scrollRef} className={`min-h-0 flex-1 overflow-y-auto ${compact ? "p-3" : "p-6"}`}>
      <div className={compact ? "space-y-3" : "mx-auto max-w-2xl space-y-4"}>
        {messages.length === 0 && empty}

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
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 rounded-2xl bg-white px-4 py-2.5 text-sm text-neutral-400 shadow-sm ring-1 ring-neutral-200 dark:bg-neutral-800 dark:ring-neutral-700">
              <Sparkles size={14} className="animate-pulse text-blue-400" /> {status}
            </div>
            <Button variant="ghost" onClick={onStop}>{t("common.cancel")}</Button>
          </div>
        )}

        {error && (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
