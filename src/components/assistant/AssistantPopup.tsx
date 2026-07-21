// A floating chat window, so the assistant is reachable without leaving the
// page you're on — the support-widget pattern.
//
// It renders in App, as a sibling of <main>, for two reasons: clicking an item
// card navigates to that item and the popup must survive it, and it has to
// float above every view rather than inside one view's scroll container.
//
// It shares App's `chat` state with AssistantView, so "Open in Assistant" is
// just navigation — there is no conversation to hand over. The two are never
// mounted at once (App hides this one on the assistant page), which is what
// keeps the hook's window-level hold-to-talk listener from doubling up.

import { Component, useEffect, type ErrorInfo, type ReactNode } from "react";
import { Sparkles, X, Maximize2, Trash2, VolumeX, AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAssistantChat, UiMessage } from "./useAssistantChat";
import MessageList from "./MessageList";
import Composer from "./Composer";
import type { GoTo } from "../../types";

/**
 * Contains a crash inside the popup. Same reasoning as the Today cards': the
 * popup renders in App's tree, above every view, so an unguarded throw here
 * would blank the entire app rather than just the chat window.
 */
class PopupBoundary extends Component<{ message: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Assistant popup failed to render", error, info);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="flex items-start gap-2 p-4 text-sm text-neutral-500">
        <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-500" />
        <span>{this.props.message}</span>
      </div>
    );
  }
}

export default function AssistantPopup({
  messages, setMessages, goTo, open, setOpen,
}: {
  messages: UiMessage[];
  setMessages: (m: UiMessage[]) => void;
  goTo: GoTo;
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  // Hold-to-talk is only live while the window is open — otherwise holding
  // Space on any page would start a recording with nothing on screen to show
  // for it, and no way to tell it had started.
  const chat = useAssistantChat({ messages, setMessages, spaceEnabled: open });

  // Closing collapses the window but keeps this component mounted, so the
  // hook's unmount cleanup never runs: a recording started before the close
  // would keep the mic open with no visible way to stop it, and a spoken reply
  // would carry on with its Stop button gone.
  useEffect(() => { if (!open) chat.cancelInput(); }, [open]);

  // Escape closes, but cancels first if something is running: the key should
  // undo the most recent thing, not throw away a turn that's mid-flight.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (chat.recording || chat.loading) { chat.stopAssistant(); return; }
      if (chat.speaking) { chat.stopVoice(); return; }
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, chat.recording, chat.loading, chat.speaking]);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg transition hover:bg-blue-700"
        aria-label={t("assistant.openChat")}
        title={t("assistant.openChat")}
      >
        <Sparkles size={20} />
      </button>
    );
  }

  return (
    // max-h keeps the window inside a short viewport; the transcript scrolls.
    <div className="fixed bottom-4 right-4 z-40 flex max-h-[calc(100vh-2rem)] w-[380px] flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-50 shadow-2xl dark:border-neutral-700 dark:bg-neutral-900">
      <div className="flex items-center gap-1 border-b border-neutral-200 bg-white px-3 py-2 dark:border-neutral-700 dark:bg-neutral-800">
        <Sparkles size={16} className="shrink-0 text-blue-500" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{t("assistant.title")}</span>
        {chat.speaking && (
          <button
            onClick={chat.stopVoice}
            className="rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-700"
            aria-label={t("assistant.stopSpeaking")}
            title={t("assistant.stopSpeaking")}
          >
            <VolumeX size={15} />
          </button>
        )}
        {messages.length > 0 && (
          <button
            onClick={chat.clear}
            className="rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-700"
            aria-label={t("assistant.clear")}
            title={t("assistant.clear")}
          >
            <Trash2 size={15} />
          </button>
        )}
        <button
          // The conversation is already shared state, so this is pure navigation.
          onClick={() => { setOpen(false); goTo("assistant"); }}
          className="rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-700"
          aria-label={t("assistant.openInAssistant")}
          title={t("assistant.openInAssistant")}
        >
          <Maximize2 size={15} />
        </button>
        <button
          onClick={() => setOpen(false)}
          className="rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-700"
          aria-label={t("assistant.closeChat")}
          title={t("assistant.closeChat")}
        >
          <X size={15} />
        </button>
      </div>

      <PopupBoundary message={t("assistant.popupCrashed")}>
        <MessageList
          messages={messages}
          // Cards navigate but leave the window open — staying on your page with
          // the chat up is the whole point of the popup.
          goTo={goTo}
          loading={chat.loading}
          status={chat.status}
          error={chat.error}
          onStop={chat.stopAssistant}
          compact
          empty={<p className="px-2 py-6 text-center text-sm text-neutral-400">{t("assistant.popupEmpty")}</p>}
        />

        <Composer
          input={chat.input}
          setInput={chat.setInput}
          onSubmit={chat.submitTyped}
          onToggleMic={chat.toggleMic}
          recording={chat.recording}
          loading={chat.loading}
          busy={chat.busy}
          heldBySpace={chat.heldBySpace}
          compact
        />
      </PopupBoundary>
    </div>
  );
}
