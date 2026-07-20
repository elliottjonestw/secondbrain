import { ReactNode, useEffect, useState } from "react";
import {
  Eye, EyeOff, Check, CalendarDays, ExternalLink, Loader2, AlertCircle,
  Sparkles, Mic, Languages, Database, Download, Upload, LucideIcon,
  Cloud, Server, RefreshCw,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  getSettings, saveSettings, getCalendarSettings, saveCalendarSettings,
  DEFAULT_OLLAMA_URL,
  type AppSettings, type AssistantProvider, type CalDavAccount,
} from "../lib/settings";
import { listOllamaModels } from "../lib/ai";
import {
  LANGUAGES, SYSTEM_LANGUAGE, changeLanguage, matchSystemLanguage,
} from "../lib/i18n";
import { hasVoiceFor } from "../lib/voice";
import { discoverAccount } from "../lib/caldav/discovery";
import { invalidateCache, listCalendars, setCalendarVisible, LOCAL_CALENDAR_NAME } from "../lib/calendars";
import { LOCAL_CALENDAR_ID } from "../types";
import { exportBackup, importBackup } from "../lib/backup";
import { Button } from "../components/ui";

const APPLE_PASSWORD_URL = "https://account.apple.com/account/manage";

type Section = "general" | "assistant" | "voice" | "calendars" | "data";

const SECTIONS: { id: Section; labelKey: `settings.sections.${Section}`; icon: LucideIcon }[] = [
  { id: "general", labelKey: "settings.sections.general", icon: Languages },
  { id: "assistant", labelKey: "settings.sections.assistant", icon: Sparkles },
  { id: "voice", labelKey: "settings.sections.voice", icon: Mic },
  { id: "calendars", labelKey: "settings.sections.calendars", icon: CalendarDays },
  { id: "data", labelKey: "settings.sections.data", icon: Database },
];

export default function SettingsView() {
  const { t } = useTranslation();
  const [section, setSection] = useState<Section>("general");

  // The AI settings live here rather than in the panes so switching sections
  // doesn't unmount the inputs and throw away unsaved edits.
  const initial = getSettings();
  const [draft, setDraft] = useState<AppSettings>(initial);
  const [saved, setSaved] = useState(false);
  const patch = (p: Partial<AppSettings>) => setDraft((d) => ({ ...d, ...p }));

  function save() {
    saveSettings({
      assistantProvider: draft.assistantProvider,
      openaiApiKey: draft.openaiApiKey.trim(),
      openaiModel: draft.openaiModel.trim() || "gpt-4o-mini",
      ollamaBaseUrl: draft.ollamaBaseUrl.trim() || DEFAULT_OLLAMA_URL,
      ollamaModel: draft.ollamaModel.trim(),
      sttModel: draft.sttModel.trim() || "whisper-1",
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="flex h-full">
      <aside className="w-48 shrink-0 border-r border-neutral-200 p-3 dark:border-neutral-700">
        <h3 className="mb-2 text-xs font-semibold uppercase text-neutral-400">{t("settings.title")}</h3>
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
              <Icon size={16} className="shrink-0 text-neutral-500" />
              <span className="min-w-0 truncate">{t(s.labelKey)}</span>
            </button>
          );
        })}
        <p className="mt-4 px-2 text-xs leading-relaxed text-neutral-400">
          {t("settings.storedLocally")}
        </p>
      </aside>

      <div className="flex-1 overflow-y-auto p-8">
        <div className="mx-auto max-w-2xl">
          {section === "general" && <GeneralSettings />}
          {section === "assistant" && (
            <AssistantSettings draft={draft} patch={patch} onSave={save} saved={saved} />
          )}
          {section === "voice" && (
            <VoiceSettings draft={draft} patch={patch} onSave={save} saved={saved} />
          )}
          {section === "calendars" && <CalendarSettingsPane />}
          {section === "data" && <DataSettings />}
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
  const { t } = useTranslation();
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
        aria-label={reveal ? t("settings.hide") : t("settings.show")}
      >
        {reveal ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
}

function SaveRow({ onSave, saved }: { onSave: () => void; saved: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 border-t border-neutral-200 pt-5 dark:border-neutral-700">
      <Button variant="primary" onClick={onSave}>{t("common.save")}</Button>
      {saved && (
        <span className="flex items-center gap-1 text-sm text-green-600">
          <Check size={16} /> {t("settings.saved")}
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
// General (language)
// ---------------------------------------------------------------------------
function GeneralSettings() {
  const { t } = useTranslation();
  const [language, setLanguage] = useState(getSettings().language);

  // Applied immediately rather than on a Save button: the whole point of a
  // language picker is seeing the result, and there's nothing to validate.
  function pick(value: string) {
    setLanguage(value);
    saveSettings({ language: value });
    void changeLanguage(value);
  }

  const systemMatch = LANGUAGES.find((l) => l.code === matchSystemLanguage(navigator.language || "en"));

  return (
    <>
      <PaneHeader title={t("settings.general.title")}>
        {t("settings.general.description")}
      </PaneHeader>

      <Field label={t("settings.general.language")} hint={t("settings.general.languageHint")}>
        <select
          value={language}
          onChange={(e) => pick(e.target.value)}
          className={INPUT_CLASS}
        >
          <option value={SYSTEM_LANGUAGE}>
            {t("settings.general.systemOption", { language: systemMatch?.nativeName ?? "English" })}
          </option>
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>{l.nativeName}</option>
          ))}
        </select>
      </Field>
    </>
  );
}

// ---------------------------------------------------------------------------
// Assistant
// ---------------------------------------------------------------------------
const PROVIDERS: { id: AssistantProvider; labelKey: `settings.assistant.provider${"Openai" | "Ollama"}`; icon: LucideIcon }[] = [
  { id: "openai", labelKey: "settings.assistant.providerOpenai", icon: Cloud },
  { id: "ollama", labelKey: "settings.assistant.providerOllama", icon: Server },
];

function AssistantSettings({ draft, patch, onSave, saved }: PaneProps) {
  const { t } = useTranslation();
  return (
    <>
      <PaneHeader title={t("settings.sections.assistant")}>
        {t("settings.assistant.description")}
      </PaneHeader>

      {/* Provider selector — which backend answers the text assistant. */}
      <Field label={t("settings.assistant.provider")} hint={t("settings.assistant.providerHint")}>
        <div className="grid grid-cols-2 gap-2">
          {PROVIDERS.map((p) => {
            const Icon = p.icon;
            const active = draft.assistantProvider === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => patch({ assistantProvider: p.id })}
                className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium transition ${
                  active
                    ? "border-blue-400 bg-blue-50 text-blue-700 dark:border-blue-500 dark:bg-blue-950/40 dark:text-blue-300"
                    : "border-neutral-200 text-neutral-600 hover:bg-neutral-50 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
                }`}
              >
                <Icon size={16} className="shrink-0" /> {t(p.labelKey)}
              </button>
            );
          })}
        </div>
      </Field>

      {draft.assistantProvider === "openai"
        ? <OpenAiFields draft={draft} patch={patch} />
        : <OllamaFields draft={draft} patch={patch} />}

      <SaveRow onSave={onSave} saved={saved} />
    </>
  );
}

function OpenAiFields({ draft, patch }: Pick<PaneProps, "draft" | "patch">) {
  const { t } = useTranslation();
  return (
    <>
      <Field label={t("settings.assistant.apiKey")} hint={t("settings.assistant.apiKeyHint")}>
        <SecretInput
          value={draft.openaiApiKey}
          onChange={(v) => patch({ openaiApiKey: v })}
          placeholder="sk-…"
        />
      </Field>

      <Field
        label={t("settings.assistant.model")}
        hint={<>{t("settings.assistant.modelHint")} <code>gpt-4o-mini</code> / <code>gpt-4o</code></>}
      >
        <input
          value={draft.openaiModel}
          onChange={(e) => patch({ openaiModel: e.target.value })}
          placeholder="gpt-4o-mini"
          spellCheck={false}
          className={`${INPUT_CLASS} font-mono`}
        />
      </Field>
    </>
  );
}

/**
 * Ollama config. The base URL is probed (`/api/tags`) so the model field can be
 * a dropdown of what's actually pulled, with a live "connected / can't reach"
 * status. If the probe fails the field degrades to free text so a working server
 * on an unusual setup is never blocked by the discovery call.
 */
function OllamaFields({ draft, patch }: Pick<PaneProps, "draft" | "patch">) {
  const { t } = useTranslation();
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [models, setModels] = useState<string[]>([]);
  const [nonce, setNonce] = useState(0); // bump to re-probe on demand

  const url = draft.ollamaBaseUrl.trim() || DEFAULT_OLLAMA_URL;
  useEffect(() => {
    let live = true;
    setState("loading");
    // Debounce so typing a URL doesn't fire a request per keystroke.
    const timer = setTimeout(() => {
      listOllamaModels(url)
        .then((m) => { if (live) { setModels(m); setState("ok"); } })
        .catch(() => { if (live) { setModels([]); setState("error"); } });
    }, 400);
    return () => { live = false; clearTimeout(timer); };
  }, [url, nonce]);

  // Keep the saved model visible even if it isn't in the fetched list.
  const options = draft.ollamaModel && !models.includes(draft.ollamaModel)
    ? [draft.ollamaModel, ...models]
    : models;

  return (
    <>
      <Field label={t("settings.assistant.baseUrl")} hint={t("settings.assistant.baseUrlHint")}>
        <div className="flex gap-2">
          <input
            value={draft.ollamaBaseUrl}
            onChange={(e) => patch({ ollamaBaseUrl: e.target.value })}
            placeholder={DEFAULT_OLLAMA_URL}
            spellCheck={false}
            autoComplete="off"
            className={`${INPUT_CLASS} font-mono`}
          />
          <button
            type="button"
            onClick={() => setNonce((n) => n + 1)}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-neutral-200 px-3 text-sm text-neutral-600 hover:bg-neutral-50 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
            aria-label={t("settings.assistant.refresh")}
          >
            <RefreshCw size={15} className={state === "loading" ? "animate-spin" : ""} />
          </button>
        </div>
      </Field>

      {/* Connection status. */}
      <div className="mb-5 -mt-2">
        {state === "loading" && (
          <span className="flex items-center gap-1.5 text-xs text-neutral-400">
            <Loader2 size={13} className="animate-spin" /> {t("settings.assistant.probing")}
          </span>
        )}
        {state === "ok" && (
          <span className="flex items-center gap-1.5 text-xs text-green-600">
            <Check size={13} /> {t("settings.assistant.connected", { count: models.length })}
          </span>
        )}
        {state === "error" && (
          <Notice tone="error">{t("settings.assistant.unreachable", { url })}</Notice>
        )}
      </div>

      <Field label={t("settings.assistant.model")} hint={t("settings.assistant.ollamaModelHint")}>
        {state === "ok" && options.length > 0 ? (
          <select
            value={draft.ollamaModel}
            onChange={(e) => patch({ ollamaModel: e.target.value })}
            className={`${INPUT_CLASS} font-mono`}
          >
            <option value="" disabled>{t("settings.assistant.pickModel")}</option>
            {options.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        ) : (
          <input
            value={draft.ollamaModel}
            onChange={(e) => patch({ ollamaModel: e.target.value })}
            placeholder="llama3.1"
            spellCheck={false}
            className={`${INPUT_CLASS} font-mono`}
          />
        )}
      </Field>

      <div className="mb-5">
        <Notice tone="info">{t("settings.assistant.toolsNote")}</Notice>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------
function VoiceSettings({ draft, patch, onSave, saved }: PaneProps) {
  const { t, i18n } = useTranslation();
  // Spoken replies come from OS voices, which macOS ships on demand — if the
  // language's voice isn't installed the reply is simply silent, with nothing
  // in the UI to explain why. Check and say so.
  const [voiceMissing, setVoiceMissing] = useState(false);
  useEffect(() => {
    let live = true;
    void hasVoiceFor(i18n.language).then((ok) => { if (live) setVoiceMissing(!ok); });
    return () => { live = false; };
  }, [i18n.language]);

  return (
    <>
      <PaneHeader title={t("settings.sections.voice")}>
        {t("settings.voice.description")}
      </PaneHeader>

      {voiceMissing && (
        <div className="mb-5">
          <Notice tone="error">
            {t("settings.voice.noVoice", { language: i18n.language })}
          </Notice>
        </div>
      )}

      <Field
        label={t("settings.voice.sttModel")}
        hint={<>{t("settings.voice.sttHint")} <code>whisper-1</code> / <code>gpt-4o-transcribe</code></>}
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
        <Notice tone="info">{t("settings.voice.privacyNote")}</Notice>
      </div>

      <SaveRow onSave={onSave} saved={saved} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Calendars (CalDAV / iCloud)
// ---------------------------------------------------------------------------
function CalendarSettingsPane() {
  const { t } = useTranslation();
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
      setStatus(t("settings.calendars.found", { count: account.calendars.length }));
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function disconnect() {
    if (!window.confirm(t("settings.calendars.confirmDisconnect"))) return;
    saveCalendarSettings({ account: null, defaultCalendarId: LOCAL_CALENDAR_ID });
    invalidateCache();
    setPassword("");
    setStatus("");
    setError("");
    refresh();
  }

  return (
    <>
      <PaneHeader title={t("settings.sections.calendars")}>
        {t("settings.calendars.description")}
      </PaneHeader>

      {/* --- Account --------------------------------------------------- */}
      <section className="mb-8 rounded-xl border border-neutral-200 p-5 dark:border-neutral-700">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
            {t("settings.calendars.account")}
          </h2>
          {connected && (
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-green-50 px-2.5 py-0.5 text-xs font-medium text-green-700 dark:bg-green-950/40 dark:text-green-400">
              <Check size={12} /> {t("settings.calendars.connected")}
            </span>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-sm font-medium">{t("settings.calendars.appleId")}</label>
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
            <label className="mb-1.5 block text-sm font-medium">{t("settings.calendars.appPassword")}</label>
            <SecretInput
              value={password}
              onChange={setPassword}
              placeholder="xxxx-xxxx-xxxx-xxxx"
            />
          </div>
        </div>

        <p className="mt-3 text-xs leading-relaxed text-neutral-400">
          {t("settings.calendars.passwordHint")}{" "}
          <button
            type="button"
            onClick={() => void openUrl(APPLE_PASSWORD_URL)}
            className="inline-flex items-center gap-1 text-blue-500 hover:underline"
          >
            {t("settings.calendars.appleIdSettings")} <ExternalLink size={11} />
          </button>
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-neutral-200 pt-4 dark:border-neutral-700">
          <Button variant="primary" onClick={() => void connect()}>
            {busy ? (
              <span className="flex items-center gap-1.5">
                <Loader2 size={15} className="animate-spin" /> {t("settings.calendars.connecting")}
              </span>
            ) : connected ? t("settings.calendars.reconnect") : t("settings.calendars.connect")}
          </Button>
          {connected && <Button onClick={disconnect}>{t("settings.calendars.disconnect")}</Button>}
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
          {t("settings.calendars.visible")}
        </h2>
        <p className="mb-4 text-xs text-neutral-400">
          {t("settings.calendars.visibleHint")}
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
                <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-700 dark:text-neutral-400">{t("settings.calendars.builtIn")}</span>
              )}
              {cal.readOnly && (
                <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-700 dark:text-neutral-400">{t("settings.calendars.readOnly")}</span>
              )}
            </label>
          ))}
        </div>

        {!connected && (
          <p className="mt-3 text-xs text-neutral-400">
            {t("settings.calendars.connectPrompt")}
          </p>
        )}
        {connected && remoteCount === 0 && (
          <p className="mt-3 text-xs text-neutral-400">
            {t("settings.calendars.noneFound")}
          </p>
        )}
      </section>

      {/* --- Default --------------------------------------------------- */}
      <section className="rounded-xl border border-neutral-200 p-5 dark:border-neutral-700">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          {t("settings.calendars.defaultCalendar")}
        </h2>
        <p className="mb-4 text-xs leading-relaxed text-neutral-400">
          {t("settings.calendars.defaultHint", { calendar: LOCAL_CALENDAR_NAME })}
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

// ---------------------------------------------------------------------------
// Data (backup / restore)
// ---------------------------------------------------------------------------
function DataSettings() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  async function doExport() {
    setBusy("export");
    setError("");
    setStatus("");
    try {
      const path = await exportBackup();
      if (path) setStatus(t("settings.data.exported"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function doImport() {
    setError("");
    setStatus("");
    // Destructive: replaces everything currently in the app.
    if (!window.confirm(t("settings.data.confirmImport"))) return;
    setBusy("import");
    try {
      const result = await importBackup();
      if (result) {
        // Reload so every view re-reads the DB and the restored language applies.
        window.location.reload();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  return (
    <>
      <PaneHeader title={t("settings.data.title")}>
        {t("settings.data.description")}
      </PaneHeader>

      <section className="mb-6 rounded-xl border border-neutral-200 p-5 dark:border-neutral-700">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          {t("settings.data.exportHeading")}
        </h2>
        <p className="mb-4 text-xs leading-relaxed text-neutral-400">
          {t("settings.data.exportHint")}
        </p>
        <Button variant="primary" onClick={() => void doExport()}>
          {busy === "export" ? (
            <span className="flex items-center gap-1.5">
              <Loader2 size={15} className="animate-spin" /> {t("settings.data.exporting")}
            </span>
          ) : (
            <span className="flex items-center gap-1.5"><Download size={15} /> {t("settings.data.exportButton")}</span>
          )}
        </Button>
        {status && (
          <div className="mt-3 flex items-center gap-1 text-sm text-green-600">
            <Check size={16} /> {status}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-neutral-200 p-5 dark:border-neutral-700">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          {t("settings.data.importHeading")}
        </h2>
        <p className="mb-4 text-xs leading-relaxed text-neutral-400">
          {t("settings.data.importHint")}
        </p>
        <Button onClick={() => void doImport()}>
          {busy === "import" ? (
            <span className="flex items-center gap-1.5">
              <Loader2 size={15} className="animate-spin" /> {t("settings.data.importing")}
            </span>
          ) : (
            <span className="flex items-center gap-1.5"><Upload size={15} /> {t("settings.data.importButton")}</span>
          )}
        </Button>
        {error && <div className="mt-3"><Notice tone="error">{error}</Notice></div>}
      </section>
    </>
  );
}
