import { z } from "zod";

/**
 * Identity types and their validation schemas.
 *
 * The schemas are the contract: the Worker validates every request body
 * against them, and the client's TypeScript types are *inferred* from the same
 * declarations. That is what makes "the client cannot drift from the server" a
 * structural property rather than a convention someone has to remember.
 */

/** Membership roles, most privileged first. */
export const ROLES = ["owner", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/** True if `role` is allowed to modify a space's contents. */
export function canWrite(role: Role): boolean {
  return role === "owner" || role === "editor";
}

export interface User {
  id: string;
  email: string;
  created_at: string;
  /**
   * Whether the address has been confirmed by clicking a mailed link.
   *
   * Deliberately NOT a precondition for signing in. Verification arrived after
   * accounts already existed, so enforcing it would lock out every user who
   * registered before it shipped — and the property it actually buys (the
   * address can receive mail, therefore password reset can reach its owner) is
   * only needed at reset time, which checks the mailbox directly by sending to
   * it. It is surfaced in Settings as a prompt, not a gate.
   */
  email_verified: boolean;
}

export interface SpaceMembership {
  space_id: string;
  name: string;
  role: Role;
}

/** The shape of `GET /v1/auth/me`. */
export interface Session {
  user: User;
  spaces: SpaceMembership[];
}

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

/**
 * A minimum length and nothing else. Composition rules (an uppercase, a digit,
 * a symbol) measurably push people toward `Password1!` and are not what makes a
 * password hard to guess; length is. 12 is the floor because the KDF work
 * factor is the other half of the defence.
 *
 * Enforced CLIENT-side only: the server never receives a password, just a key
 * derived from one (see `kdfParamsSchema`). That is a real trade — a modified
 * client could register a 1-character password — but it only ever weakens that
 * client's own account, and it buys the property that a plaintext password
 * never crosses the wire or reaches a log.
 */
export const passwordSchema = z
  .string()
  .min(12, "Password must be at least 12 characters.")
  .max(256, "Password must be at most 256 characters.");

export const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .email("Enter a valid email address.");

/**
 * Parameters for the client-side key derivation.
 *
 * The floors are OWASP's argon2id recommendation (m=19 MiB, t=2, p=1) and are
 * enforced server-side at registration: the client proposes, the server
 * refuses anything weaker. They're stored per user rather than hard-coded so
 * the cost can be raised later without locking out existing accounts — an
 * account keeps its original params until its next password change.
 *
 * Memory is capped as well as floored. `m` is allocated on whatever device is
 * logging in, and an unbounded value from a hostile client is a way to make
 * someone's phone fail to sign in.
 */
export const kdfParamsSchema = z.object({
  alg: z.literal("argon2id"),
  /** Memory cost, KiB. */
  m: z.number().int().min(19456).max(262144),
  /** Iterations. */
  t: z.number().int().min(2).max(10),
  /** Parallelism. */
  p: z.number().int().min(1).max(4),
});

export type KdfParams = z.infer<typeof kdfParamsSchema>;

/** What a fresh client uses when registering. ~100ms on a laptop, and still
 *  tolerable on a mid-range phone, which is the constraint that matters. */
export const DEFAULT_KDF_PARAMS: KdfParams = { alg: "argon2id", m: 19456, t: 2, p: 1 };

/** Base64 of at least 16 random bytes. */
const saltSchema = z.string().min(24).max(128);
/** Base64 of the 32-byte derived key. */
const derivedKeySchema = z.string().min(43).max(64);

export const registerSchema = z.object({
  email: emailSchema,
  kdf_salt: saltSchema,
  kdf_params: kdfParamsSchema,
  derived_key: derivedKeySchema,
  /** Optional label for the space created alongside the account. */
  space_name: z.string().trim().min(1).max(100).optional(),
});

/**
 * Step 1 of login: fetch the KDF parameters for an address.
 *
 * This endpoint cannot 404 on an unknown address without becoming an account
 * existence oracle for anyone who can send it a list of emails. It therefore
 * always answers, returning a salt derived deterministically from
 * HMAC(pepper, email_norm) for addresses it doesn't know — deterministic so
 * that repeated probes for the same address stay self-consistent, which a
 * random fake salt would not.
 */
export const kdfChallengeSchema = z.object({ email: emailSchema });

export interface KdfChallenge {
  kdf_salt: string;
  kdf_params: KdfParams;
}

export const loginSchema = z.object({
  email: emailSchema,
  derived_key: derivedKeySchema,
  /** Shown in the session list so a user can tell their devices apart. */
  device_label: z.string().trim().max(100).optional(),
});

export const refreshSchema = z.object({
  refresh_token: z.string().min(1),
});

/**
 * Ask for a reset link. Answers identically for every address.
 *
 * The response must be indistinguishable for a known and an unknown address,
 * for the same reason `/auth/kdf` returns a decoy salt rather than a 404 —
 * otherwise anyone with an email list can test it for membership. That
 * includes the failure modes: "email sending isn't configured" has to be
 * returned for everyone or for nobody.
 */
export const forgotPasswordSchema = z.object({ email: emailSchema });

/**
 * Complete a reset.
 *
 * The client sends a *new* salt and a key derived under it, never a password —
 * the reset path preserves the property that the server has never seen a
 * plaintext password, at the one moment it would be most tempting to break it.
 * `kdf_params` travels too so an old account picks up current parameters when
 * it changes password, which is the only moment they can safely be raised.
 */
export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  kdf_salt: saltSchema,
  kdf_params: kdfParamsSchema,
  derived_key: derivedKeySchema,
});

export const verifyEmailSchema = z.object({
  token: z.string().min(20).max(200),
});

/**
 * Ask for another confirmation link, WITHOUT a session.
 *
 * Needed because verification is now a precondition for signing in: a user who
 * hasn't confirmed can't log in, so the resend can't sit behind auth. It
 * therefore has to be oracle-safe exactly like `/auth/password/forgot` —
 * identical response for a confirmed address, an unconfirmed one, and one with
 * no account at all.
 */
export const resendVerificationSchema = z.object({ email: emailSchema });

/**
 * Delete the caller's account. Re-authentication, not just a valid session:
 * an access token can be fifteen minutes old and sitting on an unlocked
 * laptop, and this is the one irreversible operation in the API.
 */
export const deleteAccountSchema = z.object({
  derived_key: derivedKeySchema,
});

export type RegisterRequest = z.infer<typeof registerSchema>;
export type LoginRequest = z.infer<typeof loginSchema>;
export type RefreshRequest = z.infer<typeof refreshSchema>;
export type KdfChallengeRequest = z.infer<typeof kdfChallengeSchema>;
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordRequest = z.infer<typeof resetPasswordSchema>;
export type VerifyEmailRequest = z.infer<typeof verifyEmailSchema>;
export type ResendVerificationRequest = z.infer<typeof resendVerificationSchema>;
export type DeleteAccountRequest = z.infer<typeof deleteAccountSchema>;

/**
 * What registration returns now.
 *
 * NOT a `TokenPair`: since a confirmed address is required to sign in,
 * registration no longer logs anyone in — doing so would be a hole straight
 * through the gate. The client shows a "check your inbox" state and sends the
 * user to sign in once they've clicked the link.
 */
export interface RegisterResult {
  email: string;
  verification_required: true;
}

/** What register / login / refresh all return. */
export interface TokenPair {
  access_token: string;
  /** Seconds until `access_token` expires — not a timestamp, so a client with
   *  a skewed clock still refreshes on time. */
  expires_in: number;
  refresh_token: string;
  session: Session;
}
