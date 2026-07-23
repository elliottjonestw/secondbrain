import {
  normalizeEmail,
  type KdfChallenge,
  type Session,
  type TokenPair,
} from "@secondbrain/shared";
import { apiRequest, ApiError } from "./api";
import { clearCache } from "./cache";
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
 * Ask for a password-reset link.
 *
 * Resolves the same way whether or not the address has an account — the server
 * answers identically on purpose, and the UI must not invent a distinction it
 * was deliberately denied. Show "check your inbox" and nothing more.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  await apiRequest<{ message: string }>("/v1/auth/password/forgot", {
    method: "POST",
    anonymous: true,
    body: { email: email.trim() },
  });
}

/**
 * Complete a reset with the token from the emailed link.
 *
 * A fresh salt, and the current default parameters rather than the account's
 * old ones: a password change is the only safe moment to raise the work factor,
 * and reusing the old salt would let a previously captured derived key be
 * replayed against the new verifier.
 *
 * Returns nothing and signs nobody in. The server revoked every session as part
 * of the reset — including any an attacker held — so issuing tokens here would
 * make a stolen link a login. The caller sends the user to sign in.
 */
export async function resetPassword(token: string, password: string): Promise<void> {
  const kdfSalt = newKdfSalt();
  const derivedKey = await deriveKey(password, kdfSalt, DEFAULT_KDF_PARAMS);

  await apiRequest<void>("/v1/auth/password/reset", {
    method: "POST",
    anonymous: true,
    body: {
      token,
      kdf_salt: kdfSalt,
      kdf_params: DEFAULT_KDF_PARAMS,
      derived_key: derivedKey,
    },
  });
}

/** Confirm an address from an emailed link. Anonymous — the link is usually
 *  opened on whatever device read the mail, which may have no session. */
export async function verifyEmail(token: string): Promise<void> {
  await apiRequest<void>("/v1/auth/email/verify", {
    method: "POST",
    anonymous: true,
    body: { token },
  });
}

/** Send another confirmation link to the signed-in account's own address. */
export async function resendVerification(): Promise<void> {
  await apiRequest<void>("/v1/auth/email/verify/send", { method: "POST" });
}

/**
 * Delete the account and everything in it, permanently.
 *
 * Takes the password rather than relying on the session: the server requires a
 * freshly derived key for this one operation, because an access token can be
 * fifteen minutes old on an unattended machine. The derivation happens here,
 * so a plaintext password still never leaves the device.
 */
export async function deleteAccount(email: string, password: string): Promise<void> {
  const challenge = await apiRequest<KdfChallenge>("/v1/auth/kdf", {
    method: "POST",
    anonymous: true,
    body: { email: normalizeEmail(email) },
  });
  const derivedKey = await deriveKey(password, challenge.kdf_salt, challenge.kdf_params);

  await apiRequest<void>("/v1/auth/account/delete", {
    method: "POST",
    body: { derived_key: derivedKey },
  });

  // The session is gone server-side; clear this device so nothing tries to use
  // a refresh token that now names a user who doesn't exist.
  clearAuth();
  await clearCache().catch(() => {});
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
  // The response cache persists in IndexedDB across the reload sign-out
  // triggers, so it must be wiped explicitly — otherwise one account's cached
  // todos could render for the next person to sign in on this device.
  await clearCache().catch(() => {});
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
