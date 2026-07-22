import { argon2id } from "hash-wasm";
import {
  DEFAULT_KDF_PARAMS,
  type KdfParams,
} from "@secondbrain/shared";

/**
 * Client-side key derivation.
 *
 * The server never receives a password — it receives the argon2id output of
 * one. This is not a shortcut: the Workers free plan caps CPU at 10 ms per
 * request while a correct argon2id costs 50–150 ms by design, so the work had
 * to move somewhere unmetered rather than shrink. Bitwarden, 1Password and
 * Firefox Sync all work this way. See docs/cloud-migration-plan.md §5.1.
 *
 * `hash-wasm` inlines its wasm as base64, so this sidesteps the Vite wasm-path
 * trap that `@sqlite.org/sqlite-wasm` needed `optimizeDeps.exclude` for — the
 * module has no separate `.wasm` file whose URL Vite could rewrite wrongly.
 */

/** 32 bytes, matching the server's expectation. */
const KEY_LENGTH = 32;

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A fresh salt for a new account. 16 random bytes, base64. */
export function newKdfSalt(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return toBase64(b);
}

export { DEFAULT_KDF_PARAMS };

/**
 * Derive the value sent to the server in place of a password.
 *
 * Takes ~100 ms at the default parameters — deliberately. Call sites must show
 * a pending state rather than treating sign-in as instant, and must never run
 * this on a keystroke.
 */
export async function deriveKey(
  password: string,
  saltB64: string,
  params: KdfParams = DEFAULT_KDF_PARAMS,
): Promise<string> {
  const hex = await argon2id({
    password,
    salt: fromBase64(saltB64),
    parallelism: params.p,
    iterations: params.t,
    memorySize: params.m,
    hashLength: KEY_LENGTH,
    outputType: "hex",
  });

  const bytes = new Uint8Array(KEY_LENGTH);
  for (let i = 0; i < KEY_LENGTH; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return toBase64(bytes);
}
