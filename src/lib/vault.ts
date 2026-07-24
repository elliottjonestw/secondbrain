/**
 * The secrets vault.
 *
 * Two values in `settings.ts` — the OpenAI API key and the iCloud
 * app-specific password — used to sit in `localStorage` as plaintext, readable
 * from devtools by anyone at the keyboard and by any XSS on the origin. This
 * module wraps them in AES-256-GCM instead, with the key derived from the
 * account password the server never receives. The server is therefore still no
 * help: even a full database dump yields only ciphertext.
 *
 * ## Why the password, and the consequences
 *
 * The only secret unique to an account and known to this device at unlock time
 * is the password, so that is what the AES key derives from (PBKDF2, 600k
 * rounds — OWASP 2023). `restoreSession` (cold launch) does NOT have it, so two
 * things follow and are surfaced in the UI rather than hidden:
 *
 * 1. After a fresh browser launch the session is restored via the refresh token
 *    but the vault stays locked until the password is entered once. Reloads
 *    within the same tab stay unlocked, because the derived key rides along in
 *    `sessionStorage`, which a reload keeps and a browser close wipes.
 * 2. A password reset mints a new salt and a new derivation, so secrets
 *    encrypted under the old password become undecryptable and are cleared —
 *    the user re-enters them. Login with the SAME password is unaffected.
 *
 * ## Why the keys, IVs and envelopes look the way they do
 *
 * - One PBKDF2 salt per account, stored next to the ciphertext. The salt is not
 *   secret; it only stops rainbow tables and makes each account's derivation
 *   independent.
 * - A fresh 12-byte IV per encrypted value, prepended in the envelope. Reusing
 *   an IV with GCM is catastrophic, so it is never reused or chosen by hand.
 * - The GCM auth tag self-verifies the key: `decrypt` throwing means the wrong
 *   password, so `unlock` needs no separate check string in the common case.
 *   A `vaultCheck` probe is still written so unlock can be verified before any
 *   secret has ever been stored (otherwise a brand-new account with an empty
 *   vault would report "unlocked" with nothing to prove it).
 *
 * The crypto runs in both the browser and the Tauri webview — WebCrypto is
 * available in both, so this module is cross-platform without a platform branch.
 */

import { getCachedSession } from "./authStore";

/** 600,000 PBKDF2-SHA256 iterations. OWASP 2023 recommendation for SHA-256. */
const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_HASH = "SHA-256";
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32; // AES-256
const VAULT_CHECK_PLAINTEXT = "sekunda-vault-check";

/**
 * Prefix every encrypted value carries. A stored value without this prefix is
 * legacy plaintext from before the vault existed (see `isLegacy`).
 */
const ENVELOPE_PREFIX = "vault:v1";

// --- base64 ---------------------------------------------------------------
// WebCrypto gives and takes ArrayBuffer; storage is a string. These are the
// canonical, allocation-aware conversions rather than the btoa/oncharcode loop
// used in kdf.ts, because ciphertext bytes are arbitrary (including 0x00) and
// must survive a round trip exactly.

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

// --- envelope -------------------------------------------------------------
// `vault:v1:<b64 iv>:<b64 ciphertext+tag>`. Versioned so a future scheme can
// coexist and migrate off the prefix without guessing.

/** Is `value` a plaintext holdover from before the vault? Non-empty and not a
 *  `vault:` envelope. Empty string is neither legacy nor encrypted — it's just
 *  "no secret set". */
export function isLegacySecret(value: string): boolean {
  return value.length > 0 && !value.startsWith(ENVELOPE_PREFIX + ":");
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(ENVELOPE_PREFIX + ":");
}

/** A value too short or malformed to be a real envelope. Treat as legacy so
 *  the UI offers re-entry rather than silently dropping it. */
function parseEnvelope(value: string): { iv: Uint8Array; ct: Uint8Array } | null {
  if (!isEncryptedSecret(value)) return null;
  const rest = value.slice(ENVELOPE_PREFIX.length + 1);
  const sep = rest.indexOf(":");
  if (sep <= 0 || sep === rest.length - 1) return null;
  try {
    return { iv: b64ToBytes(rest.slice(0, sep)), ct: b64ToBytes(rest.slice(sep + 1)) };
  } catch {
    return null;
  }
}

// --- the derived key, and its lifetime ------------------------------------
// The CryptoKey object is not structured-cloneable into sessionStorage, so its
// JWK form is what persists across reloads; the CryptoKey is rebuilt on import.
// Holding the key only in memory would lose it on every reload — which is the
// "re-enter on every launch" option we did NOT pick. sessionStorage dies with
// the tab/browser, which is the middle ground the plan settled on.

const SESSION_KEY_STORAGE = "vault.keyJwk";
const SESSION_UID_STORAGE = "vault.uid";

let cachedKey: CryptoKey | null = null;
let cachedUid: string | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** Re-render hook for Settings, which must flip between locked and unlocked
 *  field states. Cheap: only lock/unlock call notify, so this isn't hot. */
export function onVaultChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isVaultUnlocked(): boolean {
  return cachedKey !== null;
}

/** The account the current in-memory key was derived for, or null. Used so a
 *  sign-in as a different user doesn't keep using the previous account's key. */
export function unlockedForUid(): string | null {
  return cachedUid;
}

function currentUid(): string | null {
  return getCachedSession()?.user?.id ?? null;
}

// --- salt + check probe ---------------------------------------------------
// Stored INSIDE the settings bucket (so they follow the per-account namespacing
// for free) but under private keys the public AppSettings type never exposes.
// settings.ts reads/writes these via the helpers below so the storage layout is
// owned in one place.

export const VAULT_SALT_KEY = "__vaultSalt";
export const VAULT_CHECK_KEY = "__vaultCheck";

/** 16 random bytes, base64. Fresh per account at first unlock. */
export function newVaultSalt(): string {
  return bytesToB64(randomBytes(SALT_BYTES));
}

async function importKeyFromJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "AES-GCM", length: KEY_BYTES * 8 },
    false,
    ["decrypt", "encrypt"],
  );
}

async function deriveKey(password: string, saltB64: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: b64ToBytes(saltB64), iterations: PBKDF2_ITERATIONS, hash: PBKDF2_HASH },
    baseKey,
    { name: "AES-GCM", length: KEY_BYTES * 8 },
    true, // extractable so the JWK can be stashed for reloads
    ["encrypt", "decrypt"],
  );
}

/**
 * Derive a key from the password and hold it for this session.
 *
 * `ensureSalt`/`ensureCheck` are passed by the caller (settings.ts) because the
 * salt lives in the settings bucket and this module must not reach into its
 * storage layout directly. They run BEFORE the key is held so the salt a new
 * account needs is written even on first-ever unlock.
 *
 * Returns false on a wrong password (the check probe fails to decrypt). The
 * caller surfaces that; this module never throws user-facing errors.
 */
export async function unlockVault(
  password: string,
  uid: string,
  ensureSalt: () => string,
  checkEnvelope: string | null,
): Promise<boolean> {
  const salt = ensureSalt();
  const key = await deriveKey(password, salt);

  // A probe exists for any account that has unlocked before. For a brand-new
  // account there is none yet — write one now so the next unlock can verify.
  if (!checkEnvelope) {
    const probe = await encryptWith(key, VAULT_CHECK_PLAINTEXT);
    await writeCheck(probe);
    cachedKey = key;
    cachedUid = uid;
    persistSessionKey(key, uid);
    notify();
    return true;
  }

  try {
    await decryptWith(key, checkEnvelope);
  } catch {
    return false; // wrong password — the GCM tag did not verify
  }

  cachedKey = key;
  cachedUid = uid;
  persistSessionKey(key, uid);
  notify();
  return true;
}

/** A hook the caller sets so `unlockVault` can persist the freshly written
 *  check probe. Injected rather than imported to avoid a cycle with settings.ts. */
let writeCheckFn: ((envelope: string) => Promise<void>) | null = null;
export function setWriteCheck(fn: (envelope: string) => Promise<void>): void {
  writeCheckFn = fn;
}
async function writeCheck(envelope: string): Promise<void> {
  await writeCheckFn?.(envelope);
}

function persistSessionKey(key: CryptoKey, uid: string): void {
  void (async () => {
    try {
      const jwk = await crypto.subtle.exportKey("jwk", key);
      sessionStorage.setItem(SESSION_KEY_STORAGE, JSON.stringify(jwk));
      sessionStorage.setItem(SESSION_UID_STORAGE, uid);
    } catch {
      // If sessionStorage is disabled the key just won't survive a reload —
      // the user re-enters their password, same as the cold-launch path.
    }
  })();
}

/**
 * Rebuild the key from sessionStorage after a reload, if one is still around.
 *
 * Called once at app start. No-ops cleanly when there is nothing to restore
 * (cold launch, private mode). Does not notify: the key is back but nothing has
 * re-read the decrypted cache yet — that is the caller's job.
 */
export async function restoreSessionKey(): Promise<void> {
  if (cachedKey) return;
  try {
    const jwkRaw = sessionStorage.getItem(SESSION_KEY_STORAGE);
    const uid = sessionStorage.getItem(SESSION_UID_STORAGE);
    if (!jwkRaw || !uid) return;
    // Only restore for the account currently signed in. A reload after switching
    // accounts leaves a stale key behind; don't use it.
    if (uid !== currentUid()) {
      sessionStorage.removeItem(SESSION_KEY_STORAGE);
      sessionStorage.removeItem(SESSION_UID_STORAGE);
      return;
    }
    cachedKey = await importKeyFromJwk(JSON.parse(jwkRaw));
    cachedUid = uid;
  } catch {
    // Corrupt or unavailable — treat as locked.
  }
}

/** Drop the key from memory and sessionStorage. The ciphertext on disk is
 *  untouched and will decrypt again on the next unlock. */
export function lockVault(): void {
  if (!cachedKey && !sessionStorage.getItem(SESSION_KEY_STORAGE)) return;
  cachedKey = null;
  cachedUid = null;
  try {
    sessionStorage.removeItem(SESSION_KEY_STORAGE);
    sessionStorage.removeItem(SESSION_UID_STORAGE);
  } catch {
    /* sessionStorage disabled — nothing to clear */
  }
  notify();
}

// --- encrypt / decrypt ----------------------------------------------------
// Symmetric helpers used by settings.ts at unlock (to fill its in-memory cache)
// and at save (to write the envelope). Both are async because WebCrypto is; the
// synchronous `getSettings()` never calls them directly — see settings.ts.

async function encryptWith(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `${ENVELOPE_PREFIX}:${bytesToB64(iv)}:${bytesToB64(new Uint8Array(ct))}`;
}

export async function encryptSecret(plaintext: string): Promise<string> {
  if (!cachedKey) throw new Error("vault locked");
  return encryptWith(cachedKey, plaintext);
}

async function decryptWith(key: CryptoKey, envelope: string): Promise<string> {
  const parsed = parseEnvelope(envelope);
  if (!parsed) throw new Error("not an envelope");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: parsed.iv },
    key,
    parsed.ct,
  );
  return new TextDecoder().decode(pt);
}

/** Decrypt using the held key, or return null if the vault is locked. Throws
 *  are swallowed to null: a value we can't decrypt is treated as "no secret",
 *  matching how locked reads already behave elsewhere. */
export async function decryptSecret(envelope: string): Promise<string | null> {
  if (!cachedKey) return null;
  try {
    return await decryptWith(cachedKey, envelope);
  } catch {
    return null;
  }
}
