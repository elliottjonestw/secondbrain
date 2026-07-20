import { useState } from "react";
import { Eye, EyeOff, Check } from "lucide-react";
import { getSettings, saveSettings } from "../lib/settings";
import { Button } from "../components/ui";

export default function SettingsView() {
  const initial = getSettings();
  const [apiKey, setApiKey] = useState(initial.openaiApiKey);
  const [model, setModel] = useState(initial.openaiModel);
  const [sttModel, setSttModel] = useState(initial.sttModel);
  const [voiceReplies, setVoiceReplies] = useState(initial.voiceReplies);
  const [reveal, setReveal] = useState(false);
  const [saved, setSaved] = useState(false);

  function save() {
    saveSettings({
      openaiApiKey: apiKey.trim(),
      openaiModel: model.trim() || "gpt-4o-mini",
      sttModel: sttModel.trim() || "whisper-1",
      voiceReplies,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="mx-auto h-full max-w-xl overflow-y-auto p-8">
      <h1 className="mb-1 text-2xl font-bold">Settings</h1>
      <p className="mb-6 text-sm text-neutral-400">Configuration is stored locally on this device.</p>

      <section className="rounded-xl border border-neutral-200 p-5 dark:border-neutral-700">
        <h2 className="mb-1 text-lg font-semibold">AI Assistant</h2>
        <p className="mb-4 text-sm text-neutral-500">
          Bring your own OpenAI API key to enable the Assistant. Your key is stored only on this
          device and is sent directly to OpenAI when you ask a question.
        </p>

        <label className="mb-1 block text-sm font-medium">OpenAI API key</label>
        <div className="relative mb-4">
          <input
            type={reveal ? "text" : "password"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-…"
            spellCheck={false}
            autoComplete="off"
            className="w-full rounded-lg border border-neutral-200 py-2 pl-3 pr-10 font-mono text-sm outline-none focus:border-blue-400 dark:border-neutral-600 dark:bg-neutral-800"
          />
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600"
            aria-label={reveal ? "Hide key" : "Show key"}
          >
            {reveal ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>

        <label className="mb-1 block text-sm font-medium">Model</label>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="gpt-4o-mini"
          spellCheck={false}
          className="mb-1 w-full rounded-lg border border-neutral-200 px-3 py-2 font-mono text-sm outline-none focus:border-blue-400 dark:border-neutral-600 dark:bg-neutral-800"
        />
        <p className="mb-4 text-xs text-neutral-400">
          e.g. <code>gpt-4o-mini</code>, <code>gpt-4o</code>. Any chat-completions model your key can access.
        </p>

        <div className="mb-4 border-t border-neutral-200 pt-4 dark:border-neutral-700">
          <h3 className="mb-2 text-sm font-semibold">Voice</h3>

          <label className="mb-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={voiceReplies}
              onChange={(e) => setVoiceReplies(e.target.checked)}
              className="h-4 w-4 accent-blue-600"
            />
            Speak the assistant's replies aloud (uses your system voice)
          </label>

          <label className="mb-1 block text-sm font-medium">Speech-to-text model</label>
          <input
            value={sttModel}
            onChange={(e) => setSttModel(e.target.value)}
            placeholder="whisper-1"
            spellCheck={false}
            className="w-full rounded-lg border border-neutral-200 px-3 py-2 font-mono text-sm outline-none focus:border-blue-400 dark:border-neutral-600 dark:bg-neutral-800"
          />
          <p className="mt-1 text-xs text-neutral-400">
            Used to transcribe voice input, e.g. <code>whisper-1</code> or <code>gpt-4o-transcribe</code>. Voice input sends audio to OpenAI; spoken replies are generated locally by your OS.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button variant="primary" onClick={save}>Save</Button>
          {saved && (
            <span className="flex items-center gap-1 text-sm text-green-600">
              <Check size={16} /> Saved
            </span>
          )}
        </div>
      </section>

      <p className="mt-4 text-xs text-neutral-400">
        Get an API key at platform.openai.com. Usage is billed to your own OpenAI account.
      </p>
    </div>
  );
}
