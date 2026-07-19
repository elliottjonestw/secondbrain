import { useEffect, useRef, useState } from "react";
import { Send, Sparkles, Trash2, Settings as SettingsIcon } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { askAssistant, ChatMessage } from "../lib/ai";
import { hasApiKey } from "../lib/settings";
import { Button } from "../components/ui";

const SUGGESTIONS = [
  "What's on my calendar today?",
  "Which to-dos are overdue?",
  "Summarize my high-priority tasks.",
  "What notes mention the Q3 report?",
];

export default function AssistantView({ goTo }: { goTo: (v: string) => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyed, setKeyed] = useState(hasApiKey());
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setKeyed(hasApiKey()); }, []);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  async function send(text: string) {
    const q = text.trim();
    if (!q || loading) return;
    setError(null);
    const next: ChatMessage[] = [...messages, { role: "user", content: q }];
    setMessages(next);
    setInput("");
    setLoading(true);
    try {
      const reply = await askAssistant(next);
      setMessages([...next, { role: "assistant", content: reply }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // keep the user's message visible; drop the failed assistant turn
    } finally {
      setLoading(false);
    }
  }

  if (!keyed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <Sparkles size={40} className="text-blue-500" />
        <div>
          <h1 className="text-xl font-bold">AI Assistant</h1>
          <p className="mt-1 max-w-sm text-sm text-neutral-500">
            Add your OpenAI API key in Settings to ask questions about your events, to-dos,
            reminders, and notes.
          </p>
        </div>
        <Button variant="primary" onClick={() => goTo("settings")}>
          <span className="flex items-center gap-1.5"><SettingsIcon size={15} /> Open Settings</span>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-neutral-200 px-6 py-3 dark:border-neutral-700">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Sparkles size={18} className="text-blue-500" /> Assistant
        </h1>
        <div className="flex items-center gap-3">
          <span className="text-xs text-neutral-400">Read-only · answers from your data</span>
          {messages.length > 0 && (
            <Button variant="ghost" onClick={() => { setMessages([]); setError(null); }}>
              <span className="flex items-center gap-1.5"><Trash2 size={14} /> Clear</span>
            </Button>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-2xl space-y-4">
          {messages.length === 0 && (
            <div className="pt-8 text-center">
              <p className="mb-4 text-sm text-neutral-400">Ask me anything about your data. For example:</p>
              <div className="mx-auto flex max-w-md flex-col gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="rounded-lg border border-neutral-200 px-3 py-2 text-left text-sm hover:border-blue-400 hover:bg-blue-50 dark:border-neutral-700 dark:hover:bg-blue-900/20"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
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
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="rounded-2xl bg-white px-4 py-2.5 text-sm text-neutral-400 shadow-sm ring-1 ring-neutral-200 dark:bg-neutral-800 dark:ring-neutral-700">
                Thinking…
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
        <div className="mx-auto flex max-w-2xl items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(input); }
            }}
            rows={1}
            placeholder="Ask about your calendar, tasks, notes…"
            className="max-h-40 flex-1 resize-none rounded-xl border border-neutral-200 px-4 py-2.5 text-sm outline-none focus:border-blue-400 dark:border-neutral-600 dark:bg-neutral-800"
          />
          <button
            onClick={() => void send(input)}
            disabled={loading || !input.trim()}
            className="rounded-xl bg-blue-600 p-2.5 text-white hover:bg-blue-700 disabled:opacity-40"
            aria-label="Send"
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
