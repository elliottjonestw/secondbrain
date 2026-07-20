import { ReactNode, useState } from "react";
import {
  Eye, EyeOff, Check, CalendarDays, ExternalLink, Loader2, AlertCircle,
  Sparkles, Mic, LucideIcon,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  getSettings, saveSettings, getCalendarSettings, saveCalendarSettings,
  type AppSettings, type CalDavAccount,
} from "../lib/settings";
import { discoverAccount } from "../lib/caldav/discovery";
import { invalidateCache, listCalendars, setCalendarVisible, LOCAL_CALENDAR_NAME } from "../lib/calendars";
import { LOCAL_CALENDAR_ID } from "../types";
import { Button } from "../components/ui";

const APPLE_PASSWORD_URL = "https://account.apple.com/account/manage";

type Section = "assistant" | "voice" | "calendars";

const SECTIONS: { id: Section; label: string; icon: LucideIcon }[] = [
  { id: "assistant", label: "Assistant", icon: Sparkles },
  { id: "voice", label: "Voice", icon: Mic },
  { id: "calendars", label: "Calendars", icon: CalendarDays },
];

export default function SettingsView() {
  const [section, setSection] = useState<Section>("assistant");

  // The AI settings live here rather than in the panes so switching sections
  // doesn't unmount the inputs and throw away unsaved edits.
  const initial = getSettings();
  const [draft, setDraft] = useState<AppSettings>(initial);
  const [saved, setSaved] = useState(false);
  const patch = (p: Partial<AppSettings>) => setDraft((d) => ({ ...d, ...p }));

  function save() {
    saveSettings({
      openaiApiKey: draft.openaiApiKey.trim(),
      openaiModel: draft.openaiModel.trim() || "gpt-4o-mini",
      sttModel: draft.sttModel.trim() || "whisper-1",
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="flex h-full">
      <aside className="w-48 shrink-0 border-r border-neutral-200 p-3 dark:border-neutral-700">
        <h3 className="mb-2 text-xs font-semibold uppercase text-neutral-400">Settings</h3>
        {SECTIONS.map((s) => {
          const Icon = s.icon;
          return (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm ${
                section === s.id ? "bg-blue-100 dark:bg-blue-900/40" : "hover:bg-neutral-100 dark:hover:bg-neutral-700"
              }`}
            >
              <Icon size={16} className="text-neutral-500" /> {s.label}
            </button>
          );
        })}
        <p className="mt-4 px-2 text-xs leading-relaxed text-neutral-400">
          Configuration is stored locally on this device.
        </p>
      </aside>

      <div className="flex-1 overflow-y-auto p-8">
        <div className="mx-auto max-w-2xl">
          {section === "assistant" && (
            <AssistantSettings draft={draft} patch={patch} onSave={save} saved={saved} />
          )}
          {section === "voice" && (
            <VoiceSettings draft={draft} patch={patch} onSave={save} saved={saved} />
          )}
          {section === "calendars" && <CalendarSettingsPane />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------
function PaneHeader({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-6">
      <h1 className="mb-1 text-2xl font-bold">{title}</h1>
      <p className="text-sm leading-relaxed text-neutral-500">{children}</p>
    </div>
  );
}

const INPUT_CLASS =
  "w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-blue-400 dark:border-neutral-600 dark:bg-neutral-800";

function Field({
  label, hint, children,
}: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="mb-5">
      <label className="mb-1.5 block text-sm font-medium">{label}</label>
      {children}
      {hint && <p className="mt-1.5 text-xs leading-relaxed text-neutral-400">{hint}</p>}
    </div>
  );
}

/** Password-style input with a reveal toggle. */
function SecretInput({
  value, onChange, placeholder, mono = true,
}: { value: string; onChange: (v: string) => void; placeholder: string; mono?: boolean }) {
  const [reveal, setReveal] = useState(false);
  return (
    <div className="relative">
      <input
        type={reveal ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className={`${INPUT_CLASS} pr-10 ${mono ? "font-mono" : ""}`}
      />
      <button
        type="button"
        onClick={() => setReveal((v) => !v)}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600"
        aria-label={reveal ? "Hide" : "Show"}
      >
        {reveal ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
}

function SaveRow({ onSave, saved }: { onSave: () => void; saved: boolean }) {
  return (
    <div className="flex items-center gap-3 border-t border-neutral-200 pt-5 dark:border-neutral-700">
      <Button variant="primary" onClick={onSave}>Save</Button>
      {saved && (
        <span className="flex items-center gap-1 text-sm text-green-600">
          <Check size={16} /> Saved
        </span>
      )}
    </div>
  );
}

function Notice({ tone, children }: { tone: "error" | "info"; children: ReactNode }) {
  const styles = tone === "error"
    ? "bg-red-50 text-red-600 dark:bg-red-950/40"
    : "bg-neutral-100 text-neutral-500 dark:bg-neutral-700/50";
  return (
    <p className={`flex items-start gap-1.5 rounded-lg p-3 text-sm leading-relaxed ${styles}`}>
      {tone === "error" && <AlertCircle size={15} className="mt-0.5 shrink-0" />}
      <span>{children}</span>
    </p>
  );
}

interface PaneProps {
  draft: AppSettings;
  patch: (p: Partial<AppSettings>) => void;
  onSave: () => void;
  saved: boolean;
}

// ---------------------------------------------------------------------------
// Assistant
// ---------------------------------------------------------------------------
function AssistantSettings({ draft, patch, onSave, saved }: PaneProps) {
  return (
    <>
      <PaneHeader title="Assistant">
        Bring your own OpenAI API key to enable the Assistant. Your key is stored only on this
        device and is sent directly to OpenAI when you ask a question.
      </PaneHeader>

      <Field
        label="OpenAI API key"
        hint={<>Get a key at platform.openai.com. Usage is billed to your own OpenAI account.</>}
      >
        <SecretInput
          value={draft.openaiApiKey}
          onChange={(v) => patch({ openaiApiKey: v })}
          placeholder="sk-…"
        />
      </Field>

      <Field
        label="Model"
        hint={<>e.g. <code>gpt-4o-mini</code>, <code>gpt-4o</code>. Any chat-completions model your key can access.</>}
      >
        <input
          value={draft.openaiModel}
          onChange={(e) => patch({ openaiModel: e.target.value })}
          placeholder="gpt-4o-mini"
          spellCheck={false}
          className={`${INPUT_CLASS} font-mono`}
        />
      </Field>

      <SaveRow onSave={onSave} saved={saved} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------
function VoiceSettings({ draft, patch, onSave, saved }: PaneProps) {
  return (
    <>
      <PaneHeader title="Voice">
        Talk to the assistant and it replies aloud; type and it replies in text. Voice uses the same
        tools as the chat, so it can answer questions and make changes.
      </PaneHeader>

      <Field
        label="Speech-to-text model"
        hint={<>e.g. <code>whisper-1</code> or <code>gpt-4o-transcribe</code>.</>}
      >
        <input
          value={draft.sttModel}
          onChange={(e) => patch({ sttModel: e.target.value })}
          placeholder="whisper-1"
          spellCheck={false}
          className={`${INPUT_CLASS} font-mono`}
        />
      </Field>

      <div className="mb-5">
        <Notice tone="info">
          Voice input sends audio to OpenAI for transcription (billed per minute). Spoken replies are
          generated locally by your OS, so they're free and work offline. The microphone is only
          available in a packaged build, not in <code>tauri dev</code>.
        </Notice>
      </div>

      <SaveRow onSave={onSave} saved={saved} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Calendars (CalDAV / iCloud)
// ---------------------------------------------------------------------------
function CalendarSettingsPane() {
  const stored = getCalendarSettings();
  const [username, setUsername] = useState(stored.account?.username ?? "");
  const [password, setPassword] = useState(stored.account?.appPassword ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  // Bumped after any change so the calendar list re-reads from settings.
  const [, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);

  const settings = getCalendarSettings();
  const connected = !!settings.account;
  const calendars = listCalendars();
  const remoteCount = calendars.filter((c) => c.source !== "local").length;

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
      setStatus(`Found ${account.calendars.length} calendar${account.calendars.length === 1 ? "" : "s"}.`);
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
    <>
      <PaneHeader title="Calendars">
        Connect iCloud to see your Apple calendars alongside the built-in one. Events are read from
        and written to iCloud live — nothing is copied to this device, so Apple calendars need a
        connection to appear.
      </PaneHeader>

      {/* --- Account --------------------------------------------------- */}
      <section className="mb-8 rounded-xl border border-neutral-200 p-5 dark:border-neutral-700">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
            iCloud account
          </h2>
          {connected && (
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-green-50 px-2.5 py-0.5 text-xs font-medium text-green-700 dark:bg-green-950/40 dark:text-green-400">
              <Check size={12} /> Connected
            </span>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-sm font-medium">Apple ID</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="you@icloud.com"
              spellCheck={false}
              autoComplete="off"
              className={INPUT_CLASS}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">App-specific password</label>
            <SecretInput
              value={password}
              onChange={setPassword}
              placeholder="xxxx-xxxx-xxxx-xxxx"
            />
          </div>
        </div>

        <p className="mt-3 text-xs leading-relaxed text-neutral-400">
          Your regular Apple password won't work with two-factor authentication. Create an
          app-specific password under Sign-In and Security, then paste it here.{" "}
          <button
            type="button"
            onClick={() => void openUrl(APPLE_PASSWORD_URL)}
            className="inline-flex items-center gap-1 text-blue-500 hover:underline"
          >
            Apple ID settings <ExternalLink size={11} />
          </button>
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-neutral-200 pt-4 dark:border-neutral-700">
          <Button variant="primary" onClick={() => void connect()}>
            {busy ? (
              <span className="flex items-center gap-1.5">
                <Loader2 size={15} className="animate-spin" /> Connecting…
              </span>
            ) : connected ? "Reconnect" : "Connect"}
          </Button>
          {connected && <Button onClick={disconnect}>Disconnect</Button>}
          {status && (
            <span className="flex items-center gap-1 text-sm text-green-600">
              <Check size={16} /> {status}
            </span>
          )}
        </div>

        {error && <div className="mt-3"><Notice tone="error">{error}</Notice></div>}
      </section>

      {/* --- Calendar list --------------------------------------------- */}
      <section className="mb-8 rounded-xl border border-neutral-200 p-5 dark:border-neutral-700">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Visible calendars
        </h2>
        <p className="mb-4 text-xs text-neutral-400">
          Uncheck a calendar to hide it from the Calendar and Today views.
        </p>

        <div className="space-y-0.5">
          {calendars.map((cal) => (
            <label
              key={cal.id}
              className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-700/40"
            >
              <input
                type="checkbox"
                checked={cal.visible}
                onChange={(e) => { setCalendarVisible(cal.id, e.target.checked); refresh(); }}
                className="h-4 w-4 accent-blue-600"
              />
              <span
                className="h-3 w-3 shrink-0 rounded-full"
                style={{ background: cal.color ?? "#3b82f6" }}
              />
              <span className="min-w-0 truncate">{cal.name}</span>
              {cal.source === "local" && (
                <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-700 dark:text-neutral-400">built-in</span>
              )}
              {cal.readOnly && (
                <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-700 dark:text-neutral-400">read-only</span>
              )}
            </label>
          ))}
        </div>

        {!connected && (
          <p className="mt-3 text-xs text-neutral-400">
            Connect an account above to add more calendars.
          </p>
        )}
        {connected && remoteCount === 0 && (
          <p className="mt-3 text-xs text-neutral-400">
            No Apple event calendars were found on this account.
          </p>
        )}
      </section>

      {/* --- Default --------------------------------------------------- */}
      <section className="rounded-xl border border-neutral-200 p-5 dark:border-neutral-700">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Default calendar
        </h2>
        <p className="mb-4 text-xs leading-relaxed text-neutral-400">
          New events land here when you don't pick a calendar — including events the assistant
          creates. The built-in {LOCAL_CALENDAR_NAME} calendar is the only one that works offline.
        </p>
        <select
          value={settings.defaultCalendarId}
          onChange={(e) => { saveCalendarSettings({ defaultCalendarId: e.target.value }); refresh(); }}
          className={INPUT_CLASS}
        >
          {calendars.filter((c) => !c.readOnly).map((cal) => (
            <option key={cal.id} value={cal.id}>{cal.name}</option>
          ))}
        </select>
      </section>
    </>
  );
}
