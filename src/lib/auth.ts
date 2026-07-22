import {
  normalizeEmail,
  type KdfChallenge,
  type Session,
  type TokenPair,
} from "@secondbrain/shared";
import { apiRequest, ApiError } from "./api";
import { DEFAULT_KDF_PARAMS, deriveKey, newKdfSalt } from "./kdf";
import {
  clearAuth,
  getCachedSession,
  getRefreshToken,
  setAccessToken,
  setCachedSession,
  setRefreshToken,
} from "./authStore";

/**
 * Account operations, in terms the UI can use.
 *
 * The two-step login (fetch KDF params, then submit a derived key) is entirely
 * contained here — no view should have to know that a password is never sent.
 */

function adopt(tokens: TokenPair): Session {
  setAccessToken(tokens.access_token, tokens.expires_in);
  setRefreshToken(tokens.refresh_token);
  setCachedSession(tokens.session);
  return tokens.session;
}

export async function register(
  email: string,
  password: string,
  spaceName?: string,
): Promise<Session> {
  const kdfSalt = newKdfSalt();
  const derivedKey = await deriveKey(password, kdfSalt, DEFAULT_KDF_PARAMS);

  const tokens = await apiRequest<TokenPair>("/v1/auth/register", {
    method: "POST",
    anonymous: true,
    body: {
      email: email.trim(),
      kdf_salt: kdfSalt,
      kdf_params: DEFAULT_KDF_PARAMS,
      derived_key: derivedKey,
      ...(spaceName ? { space_name: spaceName } : {}),
    },
  });

  return adopt(tokens);
}

export async function login(
  email: string,
  password: string,
  deviceLabel?: string,
): Promise<Session> {
  // Step 1: the parameters this account was created with. Always answers, even
  // for an address with no account, so this call reveals nothing.
  const challenge = await apiRequest<KdfChallenge>("/v1/auth/kdf", {
    method: "POST",
    anonymous: true,
    body: { email: normalizeEmail(email) },
  });

  // Step 2: prove knowledge of the password without sending it.
  const derivedKey = await deriveKey(password, challenge.kdf_salt, challenge.kdf_params);

  const tokens = await apiRequest<TokenPair>("/v1/auth/login", {
    method: "POST",
    anonymous: true,
    body: {
      email: email.trim(),
      derived_key: derivedKey,
      ...(deviceLabel ? { device_label: deviceLabel } : {}),
    },
  });

  return adopt(tokens);
}

/**
 * Sign out, telling the server first so the refresh token is actually revoked
 * rather than merely forgotten.
 *
 * Local state is cleared regardless of whether that call succeeds — a user who
 * asks to sign out while offline must still end up signed out on this device.
 */
export async function logout(): Promise<void> {
  const refresh = getRefreshToken();
  if (refresh) {
    try {
      await apiRequest<void>("/v1/auth/logout", {
        method: "POST",
        anonymous: true,
        body: { refresh_token: refresh },
      });
    } catch {
      // Best effort.
    }
  }
  clearAuth();
}

/**
 * Resolve the session at launch.
 *
 * Returns the cached session immediately if there is one, then confirms with
 * the server. `null` means "show the login screen".
 */
export async function restoreSession(): Promise<Session | null> {
  if (!getRefreshToken()) return null;
  try {
    const session = await apiRequest<Session>("/v1/auth/me");
    setCachedSession(session);
    return session;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      clearAuth();
      return null;
    }
    // Offline, or the server is down. Trust the cache rather than throwing the
    // user back to a login screen they cannot complete without a network.
    return getCachedSession();
  }
}
