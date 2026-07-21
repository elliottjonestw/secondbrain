import { useEffect, useState } from "react";
import { Sparkles, Trash2, Settings as SettingsIcon, VolumeX } from "lucide-react";
import { useTranslation } from "react-i18next";
import { isAssistantConfigured } from "../lib/settings";
import { Button } from "../components/ui";
import { useAssistantChat, UiMessage } from "../components/assistant/useAssistantChat";
import MessageList from "../components/assistant/MessageList";
import Composer from "../components/assistant/Composer";
import type { GoTo } from "../types";

// Rendered from the catalog so the examples read naturally in each language
// rather than being English prompts shown to a Chinese speaker.
const SUGGESTION_KEYS = [
  "assistant.suggestion1", "assistant.suggestion2",
  "assistant.suggestion3", "assistant.suggestion4",
] as const;

export type { UiMessage };

export default function AssistantView({
  messages, setMessages, goTo,
}: {
  // Owned by App so navigating to an item and back doesn't wipe the conversation.
  messages: UiMessage[];
  setMessages: (m: UiMessage[]) => void;
  goTo: GoTo;
}) {
  const { t } = useTranslation();
  const [keyed, setKeyed] = useState(isAssistantConfigured());
  const chat = useAssistantChat({ messages, setMessages });

  useEffect(() => { setKeyed(isAssistantConfigured()); }, []);

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
          {chat.speaking && (
            <Button variant="ghost" onClick={chat.stopVoice}>
              <span className="flex items-center gap-1.5"><VolumeX size={14} /> {t("assistant.stopSpeaking")}</span>
            </Button>
          )}
          <span className="text-xs text-neutral-400">{t("assistant.tagline")}</span>
          {messages.length > 0 && (
            <Button variant="ghost" onClick={chat.clear}>
              <span className="flex items-center gap-1.5"><Trash2 size={14} /> {t("assistant.clear")}</span>
            </Button>
          )}
        </div>
      </div>

      <MessageList
        messages={messages}
        goTo={goTo}
        loading={chat.loading}
        status={chat.status}
        error={chat.error}
        onStop={chat.stopAssistant}
        empty={
          <div className="pt-8 text-center">
            <p className="mb-4 text-sm text-neutral-400">
{t("assistant.emptyPrompt")}
            </p>
            <div className="mx-auto flex max-w-md flex-col gap-2">
              {SUGGESTION_KEYS.map((k) => t(k)).map((s) => (
                <button
                  key={s}
                  onClick={() => chat.deliver(s, false)}
                  className="rounded-lg border border-neutral-200 px-3 py-2 text-left text-sm hover:border-blue-400 hover:bg-blue-50 dark:border-neutral-700 dark:hover:bg-blue-900/20"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        }
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
      />
    </div>
  );
}
