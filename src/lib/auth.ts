import {
  normalizeEmail,
  type KdfChallenge,
  type RegisterResult,
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
import { isVaultUnlocked, restoreSessionKey, unlockVault } from "./vault";
import { ensureVaultSalt, readVaultCheck, refreshSecretCache, clearSecretEnvelopes } from "./settings";

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

/**
 * Derive the vault key for an account from its password and populate the
 * decrypted secret cache.
 *
 * `ensureVaultSalt`/`readVaultCheck` come from settings.ts because the salt and
 * check probe live in the per-account settings bucket — vault.ts owns the crypto
 * but not that storage layout. On success, refreshSecretCache() pulls the now-
 * decryptable OpenAI key and iCloud password into memory so getSettings() sees
 * them without awaiting anything.
 *
 * Special case: a password reset (done offline from an email link) mints a new
 * server-side salt, so the LOCAL vault's salt is now stale and the check probe
 * won't verify even with the correct password. But we only get here AFTER a
 * successful `/v1/auth/login`, which means the password is definitely right — so
 * a check-probe failure here can only mean "this device's vault predates a
 * reset." In that one case we clear the undecryptable envelopes and seed a fresh
 * vault under the new password, rather than leaving the user locked out.
 *
 * IMPORTANT: this reset-recovery is ONLY safe because the password has already
 * been verified by the server. The manual `unlock()` path (below) must NOT use
 * it: there, a failed check probe genuinely means "wrong password typed," and
 * running recovery would wipe real secrets on a typo.
 */
async function unlockVaultAfterLogin(uid: string, password: string): Promise<boolean> {
  const hadCheck = readVaultCheck() !== null;
  const ok = await unlockVault(password, uid, ensureVaultSalt, readVaultCheck());
  if (ok) {
    await refreshSecretCache();
    return true;
  }
  if (hadCheck) {
    // Stale vault from before a reset (the only way to reach here with a valid
    // login). Wipe and re-initialize fresh.
    clearSecretEnvelopes();
    const fresh = await unlockVault(password, uid, ensureVaultSalt, null);
    if (fresh) await refreshSecretCache();
    return fresh;
  }
  return false;
}

/**
 * Unlock the vault from the Settings "enter password" prompt.
 *
 * Needed for the cold-launch path: `restoreSession` signs the user back in via
 * the refresh token with no password in hand, so the AES key isn't re-derived
 * and the secrets stay locked until the user proves the password once. Returns
 * false on a wrong password (the GCM check probe fails to verify) so the UI can
 * show the error without surfacing a crypto detail.
 *
 * Does NOT do reset-recovery: the password here has not been verified by the
 * server, so a failed probe is "wrong password," not "stale vault." Treating a
 * typo as a reset would wipe the user's real secrets — see unlockVaultAfterLogin
 * for why that recovery belongs only on the post-login path.
 */
export async function unlock(password: string): Promise<boolean> {
  const uid = getCachedSession()?.user?.id;
  if (!uid) return false;
  const ok = await unlockVault(password, uid, ensureVaultSalt, readVaultCheck());
  if (ok) await refreshSecretCache();
  return ok;
}

/**
 * Create an account. Does NOT sign in.
 *
 * A confirmed email is required to log in, so registration deliberately returns
 * no session — the caller shows a "check your inbox" state and routes to
 * sign-in once the link is clicked. Returning tokens here would be a hole
 * straight through that gate.
 */
export async function register(
  email: string,
  password: string,
  spaceName?: string,
  turnstileToken?: string,
): Promise<RegisterResult> {
  const kdfSalt = newKdfSalt();
  const derivedKey = await deriveKey(password, kdfSalt, DEFAULT_KDF_PARAMS);

  return apiRequest<RegisterResult>("/v1/auth/register", {
    method: "POST",
    anonymous: true,
    body: {
      email: email.trim(),
      kdf_salt: kdfSalt,
      kdf_params: DEFAULT_KDF_PARAMS,
      derived_key: derivedKey,
      ...(spaceName ? { space_name: spaceName } : {}),
      // So the welcome items land on the user's local creation day, not a UTC
      // one. Works on web and desktop (both run in a webview); only non-browser
      // API callers omit it and get the UTC fallback.
      tz_offset: new Date().getTimezoneOffset(),
      // Web only — on desktop the widget never renders, so this is undefined
      // and the Worker skips the check for the tauri:// origin.
      ...(turnstileToken ? { turnstile_token: turnstileToken } : {}),
    },
  });
}

/**
 * Ask for another confirmation link without signing in.
 *
 * Used from the sign-in screen when a login is refused for an unconfirmed
 * address, and after registration. Resolves the same way for every address —
 * the server answers identically whether or not one exists or is already
 * confirmed — so the UI must only ever say "check your inbox".
 */
export async function resendVerification(email: string): Promise<void> {
  await apiRequest<{ message: string }>("/v1/auth/email/verify/resend", {
    method: "POST",
    anonymous: true,
    body: { email: email.trim() },
  });
}

export async function login(
  email: string,
  password: string,
  deviceLabel?: string,
  turnstileToken?: string,
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
      ...(turnstileToken ? { turnstile_token: turnstileToken } : {}),
    },
  });

  const session = adopt(tokens);
  // Derive the vault key from the same password we just authenticated with —
  // this is the one moment the plaintext is in hand, so the secrets decrypt
  // immediately and the user never sees a locked state right after sign-in.
  await unlockVaultAfterLogin(session.user.id, password);
  return session;
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
    // Cold launch can't derive the vault key (no password), but if this is a
    // same-tab reload the key may still be in sessionStorage. Rebuild it and, if
    // it survived, decrypt the secrets so the session comes back fully usable
    // without a password prompt. A browser restart wipes sessionStorage, so the
    // truly-cold path stays locked until the user re-enters the password once.
    await restoreSessionKey();
    if (isVaultUnlocked()) await refreshSecretCache();
    return session;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      clearAuth();
      return null;
    }
    // Offline, or the server is down. Trust the cache rather than throwing the
    // user back to a login screen they cannot complete without a network.
    await restoreSessionKey();
    if (isVaultUnlocked()) await refreshSecretCache();
    return getCachedSession();
  }
}
