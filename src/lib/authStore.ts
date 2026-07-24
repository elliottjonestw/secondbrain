import type { Session } from "@secondbrain/shared";
import { lockVault } from "./vault";

/**
 * Where the session lives on this device.
 *
 * Isolated behind one module because the right answer differs per platform and
 * this is the only file that should have to change. Today everything runs in a
 * webview and uses `localStorage`; a hardened desktop or mobile build should
 * put the refresh token in the OS keychain, which is a swap of the four
 * functions below and nothing else.
 *
 * The access token is deliberately NOT persisted. It lives for 15 minutes and
 * is re-minted from the refresh token on launch, so writing it to disk would
 * widen the blast radius of a stolen profile directory for no benefit.
 */

const REFRESH_KEY = "auth.refreshToken";
const SESSION_KEY = "auth.session";

let accessToken: string | null = null;
let accessExpiresAt = 0;

export function getAccessToken(): string | null {
  // Treated as expired 30s early so a request can't die in flight against a
  // token that lapses between the check and the server reading it.
  if (!accessToken || Date.now() > accessExpiresAt - 30_000) return null;
  return accessToken;
}

export function setAccessToken(token: string, expiresInSeconds: number): void {
  accessToken = token;
  accessExpiresAt = Date.now() + expiresInSeconds * 1000;
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY);
}

export function setRefreshToken(token: string): void {
  localStorage.setItem(REFRESH_KEY, token);
}

/**
 * The last known session, cached so the UI can render signed-in immediately on
 * launch instead of flashing the login screen while `/auth/me` is in flight.
 *
 * It is a display cache and nothing more — never an authorization decision.
 * The server re-checks every request, and the space list it returns is the
 * only authoritative one.
 */
export function getCachedSession(): Session | null {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function setCachedSession(session: Session): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

/**
 * The space whose data the app is currently showing.
 *
 * Today this is simply the user's first (personal) space — there is one per
 * account until sharing lands. It is a single function so that when a space
 * switcher arrives, every data call picks up the change from one place rather
 * than threading a space id through the whole app.
 */
export function getCurrentSpaceId(): string | null {
  return getCachedSession()?.spaces[0]?.space_id ?? null;
}

/** Wipe every trace of the session on this device.
 *
 *  This is the single chokepoint for session invalidation (logout, deleted
 *  account, rejected refresh token, recovery flows), so it also locks the vault:
 *  dropping the AES key and the decrypted secret cache. The ciphertext on disk
 *  is untouched and will decrypt again on the next successful sign-in. */
export function clearAuth(): void {
  accessToken = null;
  accessExpiresAt = 0;
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(SESSION_KEY);
  lockVault();
}
