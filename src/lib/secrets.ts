// The two credentials the app holds on the user's behalf: the OpenAI API key
// and the iCloud app-specific password.
//
// They used to be ordinary fields — `AppSettings.openaiApiKey` and
// `CalDavAccount.appPassword` — which meant every piece of code that touched a
// settings object touched a secret, and three separate places had to *remember*
// to exclude them: the cloud-sync allowlist (`CLOUD_SETTING_KEYS`), the backup
// writer (`backup.ts`), and the Settings view's draft state. Prevention by
// discipline, repeated. Here they are their own storage keys behind their own
// accessors, so the allowlist is no longer the last line of defence and there
// is exactly one file to audit.
//
// **This is not encryption.** The values are still plaintext in localStorage,
// readable from devtools by anyone at the keyboard and by any XSS on the
// origin. What this module buys is a smaller surface, a shorter lifetime
// (`clearSecrets` runs on sign-out — see `auth.ts`) and one honest place to say
// so. The real fix at rest is the OS keychain on desktop; that needs a Rust
// plugin and an async read hydrated at launch, which is why it isn't here yet.
//
// Reads stay SYNCHRONOUS. `ai.ts`, `voice.ts`, `openaiTts.ts` and the CalDAV
// client all read on a request path, and making them await would push async
// through half the app for no security gain — localStorage is synchronous
// whatever we wrap it in.

import { scopedKey } from "./settings";

/** Per-account, same scoping rule as the settings buckets. */
const OPENAI_KEY = "secondbrain.secret.openai";
const CALDAV_KEY = "secondbrain.secret.caldav";

function read(base: string): string {
  try {
    return localStorage.getItem(scopedKey(base)) ?? "";
  } catch {
    return "";
  }
}

function write(base: string, value: string): void {
  try {
    const key = scopedKey(base);
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* storage full or disabled — nothing useful to do, and nothing to log */
  }
}

// ---------------------------------------------------------------------------
// Adopting the pre-split values
//
// Before this module existed both secrets lived inside a settings blob. Without
// this, upgrading would silently empty an existing user's assistant and break
// their connected calendar with a 401 — an unexplained failure, not a security
// improvement. So the first read of each secret lifts it out of the old blob
// and removes it from there.
//
// Done by raw localStorage surgery rather than through `saveSettings`, because
// a patch can only set a key and this has to *delete* one. Safe to remove once
// no install predates the split.
// ---------------------------------------------------------------------------

/** Scoped keys already checked, so a user with no secret doesn't re-parse the
 *  blob on every request. Keyed by the scoped name — signing in changes it. */
const adopted = new Set<string>();

function adoptLegacy(base: string, blobKey: string, pluck: (blob: Record<string, unknown>) => unknown,
  strip: (blob: Record<string, unknown>) => void): void {
  const key = scopedKey(base);
  if (adopted.has(key)) return;
  adopted.add(key);
  try {
    if (localStorage.getItem(key) !== null) return;
    const raw = localStorage.getItem(scopedKey(blobKey));
    if (!raw) return;
    const blob = JSON.parse(raw) as Record<string, unknown>;
    const value = pluck(blob);
    if (typeof value === "string" && value) localStorage.setItem(key, value);
    strip(blob);
    localStorage.setItem(scopedKey(blobKey), JSON.stringify(blob));
  } catch {
    /* unparseable or unwritable — the user re-enters the secret, which is the
       same outcome as before this migration existed */
  }
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

export function getOpenAiKey(): string {
  adoptLegacy(OPENAI_KEY, "secondbrain.settings",
    (b) => b.openaiApiKey, (b) => { delete b.openaiApiKey; });
  return read(OPENAI_KEY).trim();
}

export function setOpenAiKey(value: string): void {
  write(OPENAI_KEY, value.trim());
}

/**
 * Is an OpenAI key present? This gates the text assistant AND all voice
 * transcription — both run on OpenAI.
 */
export function hasOpenAiKey(): boolean {
  return getOpenAiKey().length > 0;
}

/** Is the text assistant usable? The assistant runs on OpenAI, so a key is all
 *  it needs. */
export function isAssistantConfigured(): boolean {
  return hasOpenAiKey();
}

// ---------------------------------------------------------------------------
// CalDAV (iCloud)
// ---------------------------------------------------------------------------

export function getCalDavPassword(): string {
  adoptLegacy(CALDAV_KEY, "secondbrain.calendars",
    (b) => (b.account as { appPassword?: unknown } | null)?.appPassword,
    (b) => { const a = b.account as Record<string, unknown> | null; if (a) delete a.appPassword; });
  return read(CALDAV_KEY);
}

export function setCalDavPassword(value: string): void {
  write(CALDAV_KEY, value.trim());
}

// ---------------------------------------------------------------------------

/**
 * Forget both secrets on this device.
 *
 * Called from `logout()` and `deleteAccount()` — and in both cases it must run
 * BEFORE `clearAuth()`, because these keys are scoped by the signed-in user id
 * and would otherwise resolve to the `anon` bucket and wipe nothing.
 *
 * Signing out already revokes the refresh token and wipes the response cache;
 * leaving a full-scope iCloud credential and a billable API key on the disk of
 * a machine the user has just walked away from was the gap. A returning user
 * re-enters them, which is the correct price.
 *
 * Deliberately NOT called when a refresh token is simply rejected at launch:
 * that path is an expiry, not a decision to leave, and destroying credentials
 * on a transient auth failure would be its own kind of data loss.
 *
 * The two reads look pointless and are not: they force the legacy adoption
 * above to run, which is what removes the old plaintext copies from the
 * settings blobs. Without them, a user who never touched the assistant would
 * keep an un-adopted key in `secondbrain.settings` that the next read after
 * sign-in would happily adopt back.
 */
export function clearSecrets(): void {
  getOpenAiKey();
  getCalDavPassword();
  write(OPENAI_KEY, "");
  write(CALDAV_KEY, "");
  adopted.clear();
}
