/**
 * Primitives for the auth layer. Everything here is Web Crypto — no
 * dependencies, and nothing that costs meaningful CPU.
 *
 * The expensive part of password handling (argon2id) deliberately does NOT
 * live here: it runs on the client. See docs/cloud-migration-plan.md §5.1.
 */

const enc = new TextEncoder();

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Throws on malformed input — callers treat that as a bad request. */
export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** URL-safe, unpadded — refresh tokens travel in JSON but also end up in
 *  storage keys and logs where `+/=` are a nuisance. */
export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function hmac(secret: string, data: Uint8Array): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), data as BufferSource);
  return new Uint8Array(sig);
}

export async function sha256Base64(input: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return toBase64(new Uint8Array(d));
}

/**
 * The stored password verifier: `HMAC(PEPPER, verifier_salt || derived_key)`.
 *
 * HMAC rather than a plain `sha256(salt || dk || pepper)` because keyed-hash
 * construction is what HMAC is for — it makes the pepper a key rather than
 * another chunk of message, and removes any need to reason about length
 * extension or about where the boundaries between concatenated fields are.
 *
 * The input `derived_key` is ALREADY the expensive argon2id output computed on
 * the client. This step is fast on purpose; its only job is to ensure that what
 * is stored is not itself a usable credential. Storing `derived_key` raw would
 * make a database dump directly replayable as a login.
 */
export async function computeVerifier(
  pepper: string,
  verifierSaltB64: string,
  derivedKeyB64: string,
): Promise<string> {
  const salt = fromBase64(verifierSaltB64);
  const dk = fromBase64(derivedKeyB64);
  const msg = new Uint8Array(salt.length + dk.length);
  msg.set(salt, 0);
  msg.set(dk, salt.length);
  return toBase64(await hmac(pepper, msg));
}

/**
 * A stable, plausible-looking KDF salt for an address that has no account.
 *
 * `POST /v1/auth/kdf` must answer for every address or it becomes an account
 * existence oracle. The decoy is derived rather than random so that probing
 * the same address twice returns the same salt — a random decoy would answer
 * the question it exists to hide, to anyone who asked twice.
 *
 * Domain-separated by the `kdf-decoy:` prefix so this can never collide with
 * the verifier HMAC above, which uses the same key.
 */
export async function decoyKdfSalt(pepper: string, emailNorm: string): Promise<string> {
  const mac = await hmac(pepper, enc.encode(`kdf-decoy:${emailNorm}`));
  return toBase64(mac.slice(0, 16));
}

/**
 * Constant-time comparison for equal-length secrets.
 *
 * Length is compared first and non-constant-time, which is fine here: every
 * value compared is a fixed-length base64 digest, so length carries no secret.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
