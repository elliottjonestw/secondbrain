import { useState } from "react";
import { Eye, EyeOff, Check, CalendarDays, ExternalLink, Loader2, AlertCircle } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  getSettings, saveSettings, getCalendarSettings, saveCalendarSettings,
  type CalDavAccount,
} from "../lib/settings";
import { discoverAccount } from "../lib/caldav/discovery";
import { invalidateCache, listCalendars, setCalendarVisible, LOCAL_CALENDAR_NAME } from "../lib/calendars";
import { LOCAL_CALENDAR_ID } from "../types";
import { Button } from "../components/ui";

const APPLE_PASSWORD_URL = "https://account.apple.com/account/manage";

export default function SettingsView() {
  const initial = getSettings();
  const [apiKey, setApiKey] = useState(initial.openaiApiKey);
  const [model, setModel] = useState(initial.openaiModel);
  const [sttModel, setSttModel] = useState(initial.sttModel);
  const [reveal, setReveal] = useState(false);
  const [saved, setSaved] = useState(false);

  function save() {
    saveSettings({
      openaiApiKey: apiKey.trim(),
      openaiModel: model.trim() || "gpt-4o-mini",
      sttModel: sttModel.trim() || "whisper-1",
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
          <p className="mb-3 text-xs text-neutral-500">
            Talk to the assistant and it replies aloud; type and it replies in text.
          </p>

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

      <CalendarAccounts />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Calendar accounts (CalDAV / iCloud)
// ---------------------------------------------------------------------------
function CalendarAccounts() {
  const stored = getCalendarSettings();
  const [username, setUsername] = useState(stored.account?.username ?? "");
  const [password, setPassword] = useState(stored.account?.appPassword ?? "");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  // Bumped after any change so the calendar list below re-reads from settings.
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);

  const settings = getCalendarSettings();
  const connected = !!settings.account;
  const calendars = listCalendars();

  async function connect() {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const draft: CalDavAccount = {
        provider: "icloud",
        username: username.trim(),
        appPassword: password.trim(),
        calendars: [],
      };
      const account = await discoverAccount(draft, settings.account?.calendars);
      saveCalendarSettings({ account });
      invalidateCache();
      setStatus(`Connected — found ${account.calendars.length} calendar(s).`);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function disconnect() {
    if (!window.confirm("Disconnect this iCloud account? Your local calendar is untouched.")) return;
    saveCalendarSettings({ account: null, defaultCalendarId: LOCAL_CALENDAR_ID });
    invalidateCache();
    setPassword("");
    setStatus("");
    setError("");
    refresh();
  }

  return (
    <section className="mt-6 rounded-xl border border-neutral-200 p-5 dark:border-neutral-700" key={version}>
      <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold">
        <CalendarDays size={18} /> Calendar accounts
      </h2>
      <p className="mb-4 text-sm text-neutral-500">
        Connect iCloud to see your Apple calendars alongside the built-in one. Events are read from
        and written to iCloud live — nothing is copied to this device, so Apple calendars need a
        connection to appear.
      </p>

      <label className="mb-1 block text-sm font-medium">Apple ID</label>
      <input
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        placeholder="you@icloud.com"
        spellCheck={false}
        autoComplete="off"
        className="mb-3 w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-blue-400 dark:border-neutral-600 dark:bg-neutral-800"
      />

      <label className="mb-1 block text-sm font-medium">App-specific password</label>
      <div className="relative mb-1">
        <input
          type={reveal ? "text" : "password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="xxxx-xxxx-xxxx-xxxx"
          spellCheck={false}
          autoComplete="off"
          className="w-full rounded-lg border border-neutral-200 py-2 pl-3 pr-10 font-mono text-sm outline-none focus:border-blue-400 dark:border-neutral-600 dark:bg-neutral-800"
        />
        <button
          type="button"
          onClick={() => setReveal((v) => !v)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600"
          aria-label={reveal ? "Hide password" : "Show password"}
        >
          {reveal ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
      <p className="mb-4 text-xs text-neutral-400">
        Your regular Apple password will not work with two-factor authentication. Create an
        app-specific password under Sign-In and Security, then paste it here.{" "}
        <button
          type="button"
          onClick={() => void openUrl(APPLE_PASSWORD_URL)}
          className="inline-flex items-center gap-1 text-blue-500 hover:underline"
        >
          Apple ID settings <ExternalLink size={11} />
        </button>
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={() => void connect()}>
          {busy ? (
            <span className="flex items-center gap-1.5">
              <Loader2 size={15} className="animate-spin" /> Connecting…
            </span>
          ) : connected ? "Reconnect" : "Connect"}
        </Button>
        {connected && <Button variant="danger" onClick={disconnect}>Disconnect</Button>}
        {status && (
          <span className="flex items-center gap-1 text-sm text-green-600">
            <Check size={16} /> {status}
          </span>
        )}
      </div>

      {error && (
        <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-red-50 p-2.5 text-sm text-red-600 dark:bg-red-950/40">
          <AlertCircle size={15} className="mt-0.5 shrink-0" /> {error}
        </p>
      )}

      <div className="mt-5 border-t border-neutral-200 pt-4 dark:border-neutral-700">
        <h3 className="mb-2 text-sm font-semibold">Calendars</h3>
        <p className="mb-3 text-xs text-neutral-500">
          Uncheck a calendar to hide it from the Calendar and Today views.
        </p>
        <div className="space-y-1.5">
          {calendars.map((cal) => (
            <label key={cal.id} className="flex items-center gap-2.5 text-sm">
              <input
                type="checkbox"
                checked={cal.visible}
                onChange={(e) => { setCalendarVisible(cal.id, e.target.checked); refresh(); }}
                className="accent-blue-600"
              />
              <span
                className="h-3 w-3 shrink-0 rounded-full"
                style={{ background: cal.color ?? "#3b82f6" }}
              />
              <span className="truncate">{cal.name}</span>
              {cal.source === "local" && <span className="text-xs text-neutral-400">built-in</span>}
              {cal.readOnly && <span className="text-xs text-neutral-400">read-only</span>}
            </label>
          ))}
        </div>

        <label className="mt-4 block text-sm">
          <span className="mb-1 block text-sm font-medium">Default calendar</span>
          <select
            value={settings.defaultCalendarId}
            onChange={(e) => { saveCalendarSettings({ defaultCalendarId: e.target.value }); refresh(); }}
            className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-blue-400 dark:border-neutral-600 dark:bg-neutral-800"
          >
            {calendars.filter((c) => !c.readOnly).map((cal) => (
              <option key={cal.id} value={cal.id}>{cal.name}</option>
            ))}
          </select>
        </label>
        <p className="mt-1 text-xs text-neutral-400">
          New events land here when you don't pick a calendar — including events the assistant
          creates. The built-in {LOCAL_CALENDAR_NAME} calendar is the only one that works offline.
        </p>
      </div>
    </section>
  );
}
