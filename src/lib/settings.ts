// App settings, persisted in localStorage, scoped per signed-in account (see
// the note on KEY). Kept out of the database on purpose: "clear all data" must
// not erase the user's API key, and settings aren't part of the syncable
// calendar data model.
//
// MOST settings are per-device and stay that way. The handful on Settings →
// Widgets also follow the account through the Worker — see the cloud-sync
// section at the bottom of this file, and the allowlist that keeps the two
// secrets here (the OpenAI key, the iCloud app password) off the server.
//
// The authStore and api imports are safe in both directions: authStore depends
// only on @secondbrain/shared, and api.ts depends on authStore/platform/shared
// but never on this module, so neither can close a cycle.

import { CLOUD_SETTING_KEYS, type CloudSettingKey } from "@secondbrain/shared";
import { getCachedSession, getCurrentSpaceId } from "./authStore";
import { apiRequest } from "./api";
import type { ThemePreference } from "./theme";
import {
  decryptSecret,
  encryptSecret,
  isLegacySecret,
  newVaultSalt,
  onVaultChange,
  setWriteCheck,
  unlockedForUid,
  VAULT_CHECK_KEY,
  VAULT_SALT_KEY,
} from "./vault";

// ---------------------------------------------------------------------------
// Secret-bearing fields and their at-rest encryption.
//
// Two AppSettings/CalDavAccount fields are secrets: `openaiApiKey` and
// `account.appPassword`. They are encrypted with AES-256-GCM before they touch
// localStorage, using a key derived from the account password (see vault.ts).
//
// The hard constraint is that `getSettings()` is synchronous and called from
// render paths everywhere, while WebCrypto is async. The bridge is a decrypted
// in-memory cache: `refreshSecretCache()` runs once at unlock and decrypts both
// secrets into plain module variables, which `getSettings()` then reads. Locked,
// both read back as "" — and because the assistant/voice/calendar all gate on a
// non-empty key, they simply disable themselves with no call-site changes.
//
// The signed-out (anon) bucket has no password to derive from, so it stays
// plaintext by design. That path is single-local-user; if you would rather
// require a sign-in to use these features, the branch is the `!uid` check in
// `secretRead`/`secretWrite` below.
// ---------------------------------------------------------------------------

/** Decrypted plaintext, held only while the vault is unlocked. Cleared on lock
 *  and never persisted — the ciphertext on disk is the durable copy. */
let openaiApiKeyPlain = "";
let appPasswordPlain = "";

/** Track legacy plaintext separately so the UI can warn about it without
 *  confusing "locked" with "needs migration". Set by refreshSecretCache. */
let openaiApiKeyIsLegacy = false;
let appPasswordIsLegacy = false;

/** The most recent plaintext queued for async encryption. Used to drop stale
 *  encrypt resolves so rapid saves can't clobber a newer value on disk. */
let pendingOpenAiKeyPlain = "";
let pendingAppPasswordPlain = "";

/** Which text-to-speech engine speaks assistant replies. */
export type TtsEngine = "openai" | "system";

/** Bounds for `speechRate`. Both engines behave sensibly across this range. */
export const MIN_SPEECH_RATE = 0.5;
export const MAX_SPEECH_RATE = 2;

export function clampSpeechRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.min(MAX_SPEECH_RATE, Math.max(MIN_SPEECH_RATE, rate));
}

export interface AppSettings {
  openaiApiKey: string;
  openaiModel: string;
  /** Speech-to-text model used for voice input. */
  sttModel: string;
  /**
   * Which engine speaks replies. "openai" is neural voices over the network
   * (billed); "system" is the OS's offline voices. Either way the system voice
   * below is the fallback, so a reply is never lost to a network problem.
   */
  ttsEngine: TtsEngine;
  /** Text-to-speech model used for spoken replies. */
  ttsModel: string;
  /**
   * Chosen OpenAI voice. A single setting rather than one per language: these
   * voices are multilingual, so the same voice reads both English and Chinese.
   * (System voices are the opposite — each one speaks a single language — which
   * is why `preferredVoices` below stays a per-language map.)
   */
  openaiVoice: string;
  /** Speaking rate multiplier, 1 = normal. Applies to both engines. */
  speechRate: number;
  /**
   * Chosen *system* voice per speech language, as BCP 47 tag → voiceURI.
   * Empty/absent means "let the app pick the best installed voice".
   */
  preferredVoices: Record<string, string>;
  /** UI language: "system" to follow the OS, or a code from lib/i18n LANGUAGES. */
  language: string;
  /**
   * Light or dark appearance, or "system" to follow the OS. Applied by
   * `lib/theme.ts`, which owns the `dark` class on <html> — Tailwind is on the
   * class strategy precisely so this setting can override the OS.
   */
  theme: ThemePreference;
  /**
   * Where to show the weather for, or null for "don't". Resolved once by the
   * Settings place search and stored whole: the Today tile then needs no
   * geocoding lookup, so a place that has been chosen keeps working offline
   * right up to the forecast call itself.
   */
  weatherLocation: WeatherLocation | null;
  /** Temperature unit for the weather tile. Open-Meteo converts server-side. */
  temperatureUnit: TemperatureUnit;
  /**
   * Symbols on the Today ticker, in the order they're shown. Empty means the
   * card doesn't render at all — like the weather tile with no location, an
   * empty ticker would just be a standing advert for a setting.
   *
   * Resolved whole by the Settings picker (ticker *and* display name), so the
   * card never has to look a symbol up before it can draw a row.
   */
  watchlist: StockSymbol[];
  /**
   * RSS/Atom feeds on the Today page, in the order they're read.
   *
   * Cloud-synced (see CLOUD_SETTING_KEYS): a subscription list is built up over
   * months and is one of the things people most expect to find waiting on a new
   * machine. Empty means the card doesn't render — like the weather tile with
   * no location, an empty feed list would just advertise a setting.
   */
  rssFeeds: RssFeed[];
  /** How many articles the feed card shows, across all subscribed feeds. */
  rssItemCount: number;
  /**
   * Order and visibility of the Today page's cards. Stored as the user arranged
   * it, NOT as the complete truth — read it through `mergeTodayLayout`, which
   * drops ids the app no longer has and appends ones it has gained. An empty
   * array means "never customised", i.e. every card in its default order.
   */
  todayLayout: TodayCardPref[];
  /**
   * Hold the Today page's "Your day" briefing for `summaryMaxAgeHours` after it
   * was written, instead of rewriting it whenever the day's facts change. Purely
   * a spend control — that card is the app's only *automatic* billed request, so
   * ticking off four todos otherwise buys four summaries. Off means the old
   * behaviour: any change to the day regenerates. The refresh button ignores
   * this either way.
   */
  summaryThrottle: boolean;
  /** How long a written briefing stays good for, in hours. */
  summaryMaxAgeHours: number;
}

export const MIN_SUMMARY_MAX_AGE_HOURS = 1;
export const MAX_SUMMARY_MAX_AGE_HOURS = 168; // a week

export function clampSummaryMaxAge(hours: number): number {
  if (!Number.isFinite(hours)) return DEFAULTS.summaryMaxAgeHours;
  return Math.min(MAX_SUMMARY_MAX_AGE_HOURS, Math.max(MIN_SUMMARY_MAX_AGE_HOURS, Math.round(hours)));
}

/**
 * How long a cached briefing may be reused even after the day's facts change,
 * in ms. 0 when the throttle is off, i.e. only an exact fact match is reusable.
 */
export function summaryMaxAgeMs(): number {
  const s = getSettings();
  return s.summaryThrottle ? clampSummaryMaxAge(s.summaryMaxAgeHours) * 3600_000 : 0;
}

/** One card's placement on the Today page. Order is the array's own order. */
export interface TodayCardPref {
  id: string;
  hidden: boolean;
}

/**
 * Reconcile a stored layout with the cards this build actually has.
 *
 * Storage is a *preference*, not an inventory: a card added in a later version
 * must show up for someone who arranged their page in an earlier one, and a
 * card that's been removed must not linger as a dead row in the editor. So
 * known ids keep their saved order and visibility, unknown ids are dropped, and
 * anything missing is appended visible.
 */
export function mergeTodayLayout(stored: TodayCardPref[], known: readonly string[]): TodayCardPref[] {
  const valid = stored.filter((p) => known.includes(p.id));
  const seen = new Set(valid.map((p) => p.id));
  return [...valid, ...known.filter((id) => !seen.has(id)).map((id) => ({ id, hidden: false }))];
}

export const MIN_RSS_ITEMS = 1;
export const MAX_RSS_ITEMS = 20;

/** How many feeds one account may subscribe to. Every feed on the list is a
 *  relayed request on each Today load that misses the cache, so this is the
 *  same kind of cap as MAX_WATCHLIST and exists for the same reason. */
export const MAX_FEEDS = 10;

export function clampRssItemCount(count: number): number {
  if (!Number.isFinite(count)) return DEFAULTS.rssItemCount;
  return Math.min(MAX_RSS_ITEMS, Math.max(MIN_RSS_ITEMS, Math.round(count)));
}

/**
 * A subscribed feed.
 *
 * `id` is a client-minted uuid rather than the URL: it keeps React keys and
 * removal stable if a user ever edits a feed's address, and it means the list
 * reorders like every other list in the app.
 */
export interface RssFeed {
  id: string;
  /** Absolute https URL of the feed document. Validated when it's added. */
  url: string;
  /** Channel title, resolved once at add time so the settings list and the
   *  card can name the source without a fetch. Falls back to the host. */
  title: string;
}

export type TemperatureUnit = "celsius" | "fahrenheit";

/**
 * An instrument chosen in Settings. Lives here rather than in `stocks.ts` for
 * the same reason `WeatherLocation` does: it's the stored *configuration*, and
 * keeping it on this side means the provider module depends on settings and
 * never the other way round.
 */
export interface StockSymbol {
  /** Ticker as the quote service knows it, e.g. "AAPL", "0700.HK", "^GSPC". */
  symbol: string;
  /** Display name resolved once at pick time, e.g. "Apple Inc.". */
  name: string;
}

/** A place chosen in Settings, as returned by the geocoding search. */
export interface WeatherLocation {
  /** Display name, e.g. "Taipei". */
  name: string;
  /** Region/country for disambiguation in the UI, e.g. "Taiwan". */
  country: string;
  latitude: number;
  longitude: number;
}

/**
 * Settings are stored PER ACCOUNT, not per device.
 *
 * They used to be one shared bucket, which was harmless when the app had a
 * single user and no accounts. It stopped being harmless the moment anyone
 * could sign out and someone else could register on the same machine: the
 * second person inherited the first person's OpenAI API key and their iCloud
 * app-specific password, because a new account never cleared localStorage.
 *
 * Namespacing by user id fixes that, and also means a shared device keeps each
 * person's weather location, watchlist and Today layout separate.
 *
 * Signed out, reads and writes go to an `anon` bucket. That is why the login
 * screen shows the default language rather than the last user's: a preference
 * is not worth leaking which account was last used on a shared machine.
 *
 * The two secret-bearing values (`openaiApiKey`, the iCloud `appPassword`) are
 * NOT stored as plaintext: they are AES-256-GCM encrypted with a key derived
 * from the account password, so only ciphertext sits on disk and a server/DB
 * breach can't read them. See the vault helpers below and `vault.ts`. While the
 * vault is locked — a fresh launch before the password is entered — both read
 * back as empty, which is what gates the assistant/voice/calendar off. The
 * signed-out (`anon`) bucket stays plaintext: it has no password to derive from.
 */
const KEY = "secondbrain.settings";

/** The signed-in user's id, or null. Read through authStore so this module
 *  never has to know how a session is persisted. */
function currentUserId(): string | null {
  return getCachedSession()?.user?.id ?? null;
}

/**
 * The storage key for this account, migrating the pre-account bucket into it
 * on first touch.
 *
 * The migration is lazy rather than a step in the sign-in flow because it must
 * hold whatever order things load in: whoever reads settings first after an
 * upgrade adopts the old values, and the shared copy is removed so no later
 * account can inherit it.
 */
function scopedKey(base: string): string {
  const uid = currentUserId();
  const key = `${base}.${uid ?? "anon"}`;
  if (uid) {
    const legacy = localStorage.getItem(base);
    if (legacy !== null) {
      // Don't clobber a bucket this account already has.
      if (localStorage.getItem(key) === null) localStorage.setItem(key, legacy);
      localStorage.removeItem(base);
    }
  }
  return key;
}

const DEFAULTS: AppSettings = {
  openaiApiKey: "",
  openaiModel: "gpt-4o-mini",
  sttModel: "whisper-1",
  // Natural voices by default — they're the reason this setting exists. Safe as
  // a default even though they're billed: a spoken reply only happens after
  // *speech input*, which already needs an OpenAI key for Whisper. With no key
  // it falls back to the system voice rather than failing.
  ttsEngine: "openai",
  ttsModel: "gpt-4o-mini-tts",
  openaiVoice: "",
  speechRate: 1,
  preferredVoices: {},
  language: "system",
  // Follow the OS unless told otherwise, same rule as the language.
  theme: "system",
  // A fresh install gets a populated weather tile and ticker rather than two
  // cards advertising a setting. Both are ordinary values the user can change
  // or clear in Settings; clearing sticks, because a stored settings object
  // overrides these defaults key by key.
  weatherLocation: { name: "New York", country: "United States", latitude: 40.7128, longitude: -74.006 },
  temperatureUnit: "celsius",
  watchlist: [
    { symbol: "AAPL", name: "Apple Inc." },
    { symbol: "GOOGL", name: "Alphabet Inc." },
  ],
  // No feeds by default: unlike a weather location, there is no sensible guess
  // at what someone reads, and seeding one would be an editorial choice.
  rssFeeds: [],
  rssItemCount: 5,
  todayLayout: [],
  summaryThrottle: true,
  summaryMaxAgeHours: 6,
};

// ---------------------------------------------------------------------------
// The stored bucket, with envelopes intact. getSettings()/saveSettings() hide
// the encryption from every other caller; these internals are where ciphertext
// is actually handled.
// ---------------------------------------------------------------------------

/** The object on disk: AppSettings fields plus the private vault metadata. The
 *  public AppSettings type never includes the `__vault*` keys, so they can't
 *  leak out through a normal getSettings() call. */
type StoredBucket = AppSettings & {
  [VAULT_SALT_KEY]?: string;
  [VAULT_CHECK_KEY]?: string;
};

/** Read the raw bucket WITHOUT substituting decrypted secrets. Internal only —
 *  every public read goes through getSettings(), which swaps the envelope for
 *  plaintext-from-cache. */
function readRawBucket(): StoredBucket {
  try {
    const raw = localStorage.getItem(scopedKey(KEY));
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Write the raw bucket directly. Bypasses saveSettings' cloud push, because the
 *  vault metadata and ciphertext are never cloud-eligible. */
function writeRawBucket(bucket: StoredBucket): void {
  localStorage.setItem(scopedKey(KEY), JSON.stringify(bucket));
}

/** The salt for the CURRENT account's vault, creating one on first touch. */
export function ensureVaultSalt(): string {
  const uid = currentUserId();
  // Signed-out: no vault. Returns a throwaway so unlockVault's deriveKey has a
  // salt to consume, but the anon path never actually calls this.
  if (!uid) return newVaultSalt();
  const bucket = readRawBucket();
  if (bucket[VAULT_SALT_KEY]) return bucket[VAULT_SALT_KEY]!;
  const salt = newVaultSalt();
  writeRawBucket({ ...bucket, [VAULT_SALT_KEY]: salt });
  return salt;
}

/** The current account's vault-check envelope, or null if none written yet. */
export function readVaultCheck(): string | null {
  return readRawBucket()[VAULT_CHECK_KEY] ?? null;
}

/**
 * Wipe the secret envelopes AND the vault check/salt for the current account.
 *
 * Used after a password reset: the salt changes, so the old derivation no
 * longer applies and the ciphertext is permanently undecryptable. Leaving it
 * would mean the next unlock (under the new password) can never read it — better
 * to clear it and let the user re-enter. Also clears the in-memory cache so a
 * locked state is immediate.
 */
export function clearSecretEnvelopes(): void {
  // Invalidate any in-flight encrypt so a late resolve can't rewrite a value
  // this function just cleared.
  pendingOpenAiKeyPlain = "";
  pendingAppPasswordPlain = "";
  const bucket = readRawBucket();
  const { [VAULT_SALT_KEY]: _s, [VAULT_CHECK_KEY]: _c, openaiApiKey: _k, ...rest } = bucket;
  writeRawBucket({ ...rest, openaiApiKey: "" });
  // Calendar password lives in its own bucket.
  const calRaw = localStorage.getItem(scopedKey(CAL_KEY));
  if (calRaw) {
    try {
      const cal = JSON.parse(calRaw) as CalendarSettings;
      if (cal.account) writeRawCalendarSettings({ ...cal, account: { ...cal.account, appPassword: "" } });
    } catch {
      /* leave as-is */
    }
  }
  clearSecretCache();
}

// vault.ts calls back into here to persist the check probe it writes on first
// unlock. Registered once at module load to avoid a circular import.
setWriteCheck(async (envelope: string) => {
  const bucket = readRawBucket();
  writeRawBucket({ ...bucket, [VAULT_CHECK_KEY]: envelope });
});

/**
 * Repopulate the in-memory plaintext cache from whatever is on disk.
 *
 * Called by auth at unlock (the key is fresh) and on any sign-in. Three cases
 * per secret:
 *  - empty                  → cache "", not legacy
 *  - vault envelope         → decrypt to cache (or "" if the vault is locked)
 *  - legacy plaintext       → cache the plaintext so the feature still works,
 *                             and flag it so the UI can prompt for re-entry
 *
 * Legacy plaintext is deliberately NOT re-encrypted here: the plan was to
 * surface it, not silently migrate it, so the user knows an old key is still on
 * the device and chooses to re-enter it.
 */
export async function refreshSecretCache(): Promise<void> {
  const bucket = readRawBucket();
  const rawKey = bucket.openaiApiKey ?? "";
  const rawPass = readRawCalendarAccount()?.appPassword ?? "";

  // OpenAI key
  if (rawKey === "") {
    openaiApiKeyPlain = "";
    openaiApiKeyIsLegacy = false;
  } else if (isLegacySecret(rawKey)) {
    openaiApiKeyPlain = rawKey;
    openaiApiKeyIsLegacy = true;
  } else {
    openaiApiKeyPlain = (await decryptSecret(rawKey)) ?? "";
    openaiApiKeyIsLegacy = false;
  }

  // iCloud app password
  if (rawPass === "") {
    appPasswordPlain = "";
    appPasswordIsLegacy = false;
  } else if (isLegacySecret(rawPass)) {
    appPasswordPlain = rawPass;
    appPasswordIsLegacy = true;
  } else {
    appPasswordPlain = (await decryptSecret(rawPass)) ?? "";
    appPasswordIsLegacy = false;
  }
}

/** True if either secret on disk is still plaintext from before the vault. Drives
 *  the Settings "re-enter your key" banner. */
export function hasLegacyPlaintextSecret(): boolean {
  return openaiApiKeyIsLegacy || appPasswordIsLegacy;
}

/** The decrypted OpenAI key, or "" when locked. The synchronous read the
 *  assistant/voice code needs. */
export function getOpenAiKey(): string {
  return openaiApiKeyPlain.trim();
}

/** Clear the in-memory cache (not the ciphertext). Called on lock/logout. Also
 *  invalidates pending encrypts so a late resolve can't write a value back to
 *  disk after the key that encrypted it is gone. */
function clearSecretCache(): void {
  pendingOpenAiKeyPlain = "";
  pendingAppPasswordPlain = "";
  openaiApiKeyPlain = "";
  appPasswordPlain = "";
  openaiApiKeyIsLegacy = false;
  appPasswordIsLegacy = false;
}

// Locking the vault wipes the cache. Subscribe once at load.
onVaultChange(() => {
  // The listener also fires on unlock; refreshSecretCache handles that path
  // explicitly, so only react to losing the key here.
  if (!unlockedForUid()) clearSecretCache();
});

export function getSettings(): AppSettings {
  const bucket = readRawBucket();
  // Strip the private vault keys so they never escape this module.
  const { [VAULT_SALT_KEY]: _salt, [VAULT_CHECK_KEY]: _check, ...publicFields } = bucket;
  // Substitute the decrypted (or empty-when-locked) secret for the envelope.
  return { ...publicFields, openaiApiKey: openaiApiKeyPlain };
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const bucket = readRawBucket();
  let next: StoredBucket = { ...bucket, ...patch };

  // A secret in the patch arrives as plaintext from the UI. Encrypt it to an
  // envelope before it touches disk — but only while unlocked. Locked, the UI
  // can't offer the field, so this branch is unreachable in practice; the guard
  // is here so a stray call degrades safely (value kept in cache only).
  if ("openaiApiKey" in patch) {
    const plain = patch.openaiApiKey ?? "";
    openaiApiKeyPlain = plain;
    openaiApiKeyIsLegacy = false;
    if (unlockedForUid()) {
      // Synchronous save can't await encryptSecret. Re-encrypt asynchronously:
      // the cache holds the plaintext immediately so getSettings() is correct,
      // and the ciphertext lands on disk a tick later. Until then the field is
      // absent from the raw bucket, which reads back as "" — acceptable because
      // the in-memory cache is the source of truth while unlocked.
      //
      // Track the latest plaintext so that if several saves fire before an
      // encrypt resolves (rapid typing), only the most recent one writes — a
      // stale resolve that would clobber a newer value is detected and dropped.
      pendingOpenAiKeyPlain = plain;
      void encryptSecret(plain).then((envelope) => {
        if (pendingOpenAiKeyPlain !== plain) return; // a newer save superseded this
        const fresh = readRawBucket();
        writeRawBucket({ ...fresh, openaiApiKey: envelope });
      });
      const { openaiApiKey: _drop, ...rest } = patch;
      next = { ...bucket, ...rest };
    } else {
      // Locked or anon: store as-is (plaintext for anon, which is by design).
      next = { ...bucket, ...patch };
    }
  }

  writeRawBucket(next);
  // Anything on the cloud allowlist also goes to the server, in the background.
  // Local storage is written first and unconditionally, so a failed or offline
  // push costs the user nothing they can see. Secrets are never cloud-eligible.
  pushCloudSettings(pickCloud(patch));
  return getSettings();
}

// ---------------------------------------------------------------------------
// The few settings that follow the ACCOUNT rather than the device
//
// Everything above is per-device by design, and most of it should stay that
// way — a voice, a theme, a layout are answers about *this* machine. The
// Widgets page is the exception: where you are, what you hold and what you read
// are answers about you, and re-entering them on every new device is the kind
// of small tax that makes an app feel like it doesn't know you.
//
// The rule that makes this safe is CLOUD_SETTING_KEYS in @secondbrain/shared:
// the client only ever uploads a key on that list, and the Worker rejects any
// key off it. **The OpenAI API key and the iCloud app-specific password are not
// on it and must never be.** They are the two secrets in this file; the whole
// point of the allowlist is that no amount of future code up here can leak them
// to the server by accident. Adding a key means asking whether the value is a
// secret first — if it is, the answer is no.
//
// Reads stay synchronous. `getSettings()` is called from render paths all over
// the app, so the cloud is not a second source of truth to await: it is loaded
// once at sign-in by `syncSettingsFromCloud`, written into the same
// localStorage bucket, and read from there forever after. That makes the local
// copy an offline cache as well, so the Widgets page works with no network.
//
// Conflicts are last-write-wins, per key, with no merge. Two devices changing
// the same watchlist minutes apart is not worth a vector clock, and every value
// here is one the user can see and re-set.
// ---------------------------------------------------------------------------

/**
 * Keys whose local edits haven't reached the server yet.
 *
 * Without this an edit made offline would be silently reverted by the next
 * sign-in, which is a data-loss bug wearing the costume of a sync feature. The
 * pending list is consulted by `syncSettingsFromCloud`, which pushes those keys
 * instead of letting the server's older value overwrite them.
 */
const PENDING_KEY = "secondbrain.settings.pending";

function readPending(): CloudSettingKey[] {
  try {
    const raw = JSON.parse(localStorage.getItem(scopedKey(PENDING_KEY)) || "[]");
    return Array.isArray(raw) ? raw.filter(isCloudKey) : [];
  } catch {
    return [];
  }
}

function writePending(keys: CloudSettingKey[]): void {
  try {
    if (keys.length) localStorage.setItem(scopedKey(PENDING_KEY), JSON.stringify(keys));
    else localStorage.removeItem(scopedKey(PENDING_KEY));
  } catch {
    /* storage full or disabled — the push below still tries */
  }
}

function isCloudKey(key: string): key is CloudSettingKey {
  return (CLOUD_SETTING_KEYS as readonly string[]).includes(key);
}

/** The cloud-eligible subset of a patch. This function is the only place a
 *  value leaves the device, so the filter lives here and nowhere else. */
function pickCloud(patch: Partial<AppSettings>): Partial<CloudSettings> {
  // Built as a loose record and cast once: writing `out[key]` where `key` is a
  // union of literals narrows the assignable type to the INTERSECTION of the
  // value types, which is `never`. The read side (`patch[key]`) is sound, and
  // the keys come from CLOUD_SETTING_KEYS, so the shape is right by
  // construction — this is TypeScript's limit, not a loosened check.
  const out: Record<string, unknown> = {};
  for (const key of CLOUD_SETTING_KEYS) {
    if (key in patch) out[key] = patch[key];
  }
  return out as Partial<CloudSettings>;
}

/** The shape stored per key. Named so the picker above can't drift from
 *  AppSettings without a compile error. */
type CloudSettings = Pick<AppSettings, CloudSettingKey>;

/**
 * Send cloud-eligible settings to the server, in the background.
 *
 * Deliberately not awaited by `saveSettings`: every caller of that is a UI
 * event handler, and blocking a checkbox on a round-trip to make a *preference*
 * durable is the wrong trade. Failure marks the keys pending and returns — the
 * next successful save or sign-in flushes them.
 */
function pushCloudSettings(values: Partial<CloudSettings>): void {
  const keys = Object.keys(values).filter(isCloudKey);
  if (!keys.length) return;
  // Signed out, there is no account for these to follow. The anon bucket is
  // local-only by definition.
  if (!currentUserId() || !getCurrentSpaceId()) return;

  const pending = new Set([...readPending(), ...keys]);
  writePending([...pending]);

  void (async () => {
    try {
      await apiRequest(spaceSettingsPath(), { method: "PATCH", body: values });
      // Only clear what this request actually carried: another save may have
      // added a key while this one was in flight.
      writePending(readPending().filter((k) => !keys.includes(k)));
    } catch {
      // Offline, or the server said no. The keys stay pending; nothing is
      // surfaced, because the local value — the one the user is looking at —
      // was saved either way.
    }
  })();
}

/**
 * Pull this account's settings from the server into the local bucket.
 *
 * Called once when the app mounts with a session. Anything still pending from
 * an offline edit is pushed first and then left alone, so the server's older
 * copy can't undo a change the user made on this device while disconnected.
 *
 * Never throws: a failure here means the Widgets page shows this device's last
 * known values, which is exactly what it did before any of this existed.
 */
export async function syncSettingsFromCloud(): Promise<void> {
  if (!currentUserId() || !getCurrentSpaceId()) return;

  const pending = readPending();
  if (pending.length) {
    const local = getSettings();
    // Same union-key cast as `pickCloud` — see the note there.
    const values: Record<string, unknown> = {};
    for (const key of pending) values[key] = local[key];
    pushCloudSettings(values as Partial<CloudSettings>);
  }

  try {
    const remote = await apiRequest<Partial<Record<CloudSettingKey, unknown>>>(spaceSettingsPath());
    const patch: Partial<AppSettings> = {};
    for (const key of CLOUD_SETTING_KEYS) {
      // A key edited offline is authoritative here — see above.
      if (pending.includes(key)) continue;
      if (!(key in remote)) continue;
      const value = remote[key];
      if (isPlausible(key, value)) (patch as Record<string, unknown>)[key] = value;
    }
    if (Object.keys(patch).length) {
      // Straight to storage: routing through saveSettings would push what we
      // just pulled back to the server on every launch.
      localStorage.setItem(scopedKey(KEY), JSON.stringify({ ...getSettings(), ...patch }));
      notifyCloudSettingsApplied();
    }
  } catch {
    /* offline or unauthenticated — the local copy stands in */
  }
}

/**
 * Is a value from the server the right *kind* of thing for this key?
 *
 * Not full validation — a shallow check, for the same reason `weather.ts`
 * screens its cache: this data was written by a build that may be older or
 * newer than this one, and a `rssFeeds` that arrives as a string must become a
 * refusal rather than a `TypeError` inside a render. Anything that fails is
 * ignored, leaving the local default in place.
 */
function isPlausible(key: CloudSettingKey, value: unknown): boolean {
  switch (key) {
    case "weatherLocation":
      return value === null
        || (typeof value === "object" && typeof (value as WeatherLocation).latitude === "number");
    case "temperatureUnit":
      return value === "celsius" || value === "fahrenheit";
    case "watchlist":
      return Array.isArray(value) && value.every((s) => typeof s?.symbol === "string");
    case "rssFeeds":
      return Array.isArray(value) && value.every((f) => typeof f?.url === "string" && typeof f?.id === "string");
    case "rssItemCount":
      return typeof value === "number" && Number.isFinite(value);
  }
}

function spaceSettingsPath(): string {
  return `/v1/spaces/${getCurrentSpaceId()}/settings`;
}

/**
 * Notified when a cloud pull actually CHANGED something locally.
 *
 * Settings are read synchronously from storage during render, which works
 * because every other write happens in an event handler that re-renders its own
 * pane anyway. The cloud pull is the one write that lands out of band — mid-way
 * through a Today page that has already drawn — so it needs a way to say so.
 *
 * Deliberately NOT fired by `saveSettings`. The Today layout editor saves on
 * every reorder, and a general "settings changed" signal would make each ▲
 * click refetch every widget's data. This fires once per sign-in, at most.
 */
const cloudApplied = new Set<() => void>();

export function onCloudSettingsApplied(fn: () => void): () => void {
  cloudApplied.add(fn);
  return () => { cloudApplied.delete(fn); };
}

function notifyCloudSettingsApplied(): void {
  for (const fn of cloudApplied) fn();
}

/**
 * Is an OpenAI key present? This gates the text assistant AND all voice
 * transcription — both run on OpenAI. Reads the decrypted cache, so a locked
 * vault (fresh launch, pre-password) correctly disables both.
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
// Calendar accounts (CalDAV)
//
// Which calendars exist, which are visible, and which is the default is
// *configuration*, not calendar data — and remote events are never stored in
// SQLite — so all of it lives here in localStorage rather than in the DB. The
// app-specific password is a secret and is vault-encrypted like the OpenAI key:
// ciphertext on disk, plaintext only in the in-memory cache while unlocked.
// Kept under its own key so the shape can grow without disturbing AppSettings.
// ---------------------------------------------------------------------------

/** A calendar collection discovered on a CalDAV server. */
export interface CalDavCalendar {
  id: string; // stable identity = the collection href
  href: string; // absolute URL of the calendar collection
  displayName: string;
  color: string | null; // from CalDAV calendar-color, else a fallback
  visible: boolean;
  supportsVEVENT: boolean;
  readOnly: boolean;
}

export interface CalDavAccount {
  provider: "icloud"; // future: "google" | "fastmail" | "generic"
  username: string; // Apple ID
  appPassword: string; // app-specific password (2FA accounts require one)
  principalUrl?: string; // discovered
  calendarHomeUrl?: string; // discovered
  calendars: CalDavCalendar[]; // discovered, cached here
}

export interface CalendarSettings {
  account: CalDavAccount | null;
  localVisible: boolean; // show the built-in Sekunda calendar
  defaultCalendarId: string; // where new events land — "local" or a calendar id
}

const CAL_KEY = "secondbrain.calendars";

const CAL_DEFAULTS: CalendarSettings = {
  account: null,
  localVisible: true,
  defaultCalendarId: "local",
};

/** Read the raw calendar account WITHOUT substituting the decrypted password.
 *  Internal — refreshSecretCache uses it to find what's on disk. */
function readRawCalendarAccount(): CalDavAccount | null {
  try {
    const raw = localStorage.getItem(scopedKey(CAL_KEY));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CalendarSettings;
    return parsed.account ?? null;
  } catch {
    return null;
  }
}

export function getCalendarSettings(): CalendarSettings {
  try {
    const raw = localStorage.getItem(scopedKey(CAL_KEY));
    if (!raw) return { ...CAL_DEFAULTS };
    const parsed = { ...CAL_DEFAULTS, ...JSON.parse(raw) } as CalendarSettings;
    // Swap the on-disk envelope for the decrypted (or empty-when-locked) value.
    if (parsed.account) {
      parsed.account = { ...parsed.account, appPassword: appPasswordPlain };
    }
    return parsed;
  } catch {
    return { ...CAL_DEFAULTS };
  }
}

export function saveCalendarSettings(patch: Partial<CalendarSettings>): CalendarSettings {
  const current = getCalendarSettings();
  let next: CalendarSettings = { ...current, ...patch };

  // A patched account arrives with a plaintext password from the UI. Encrypt it
  // to an envelope on disk when unlocked; mirror saveSettings' async-write
  // pattern. The cache is the immediate source of truth.
  if (patch.account && unlockedForUid()) {
    const plain = patch.account.appPassword ?? "";
    appPasswordPlain = plain;
    appPasswordIsLegacy = false;
    // Write the account with the password blanked NOW: the plaintext must never
    // touch disk. The envelope lands a tick later; until then the in-memory
    // cache (read by getCalendarSettings) carries the real value.
    const { appPassword: _pw, ...accountWithoutPw } = patch.account;
    next = { ...current, account: { ...accountWithoutPw, appPassword: "" } };
    localStorage.setItem(scopedKey(CAL_KEY), JSON.stringify(next));
    // Track the latest plaintext so a stale encrypt resolve can't clobber a
    // newer value (rapid reconnect/retype).
    pendingAppPasswordPlain = plain;
    void encryptSecret(plain).then((envelope) => {
      if (pendingAppPasswordPlain !== plain) return; // superseded by a newer save
      const fresh = readRawCalendarSettings();
      if (fresh.account) {
        writeRawCalendarSettings({ ...fresh, account: { ...fresh.account, appPassword: envelope } });
      }
    });
  } else {
    // Locked or anon: store as-is.
    localStorage.setItem(scopedKey(CAL_KEY), JSON.stringify(next));
  }
  return next;
}

/** Read the raw calendar settings (with envelopes intact) without substituting
 *  the decrypted password. Internal — used by the async encrypt path. */
function readRawCalendarSettings(): CalendarSettings {
  try {
    const raw = localStorage.getItem(scopedKey(CAL_KEY));
    if (!raw) return { ...CAL_DEFAULTS };
    return { ...CAL_DEFAULTS, ...JSON.parse(raw) } as CalendarSettings;
  } catch {
    return { ...CAL_DEFAULTS };
  }
}

function writeRawCalendarSettings(settings: CalendarSettings): void {
  localStorage.setItem(scopedKey(CAL_KEY), JSON.stringify(settings));
}

/** Replace the stored calendar list for the connected account (e.g. after a
 *  visibility toggle or a re-discovery). No-op when nothing is connected. */
export function saveAccountCalendars(calendars: CalDavCalendar[]): CalendarSettings {
  const s = getCalendarSettings();
  if (!s.account) return s;
  return saveCalendarSettings({ account: { ...s.account, calendars } });
}

export function hasCalendarAccount(): boolean {
  const s = getCalendarSettings();
  return !!s.account && s.account.calendars.length > 0;
}
