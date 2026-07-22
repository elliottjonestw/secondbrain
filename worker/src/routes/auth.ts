import { Hono } from "hono";
import {
  DEFAULT_KDF_PARAMS,
  kdfChallengeSchema,
  loginSchema,
  normalizeEmail,
  normalizeKey,
  refreshSchema,
  registerSchema,
  type KdfChallenge,
  type KdfParams,
  type Session,
  type TokenPair,
} from "@secondbrain/shared";
import type { AppEnv, Bindings } from "../env";
import { badRequest, conflict, unauthorized } from "../http";
import {
  computeVerifier,
  decoyKdfSalt,
  randomBytes,
  timingSafeEqual,
  toBase64,
} from "../auth/crypto";
import {
  ACCESS_TTL_SECONDS,
  createSession,
  revokeByToken,
  rotateSession,
  signAccessToken,
} from "../auth/tokens";
import {
  assertNotLocked,
  clearBucket,
  clientIp,
  emailBucket,
  ipBucket,
  recordFailure,
} from "../auth/throttle";
import {
  createUserWithSpace,
  findUserByEmail,
  findUserById,
  listMemberships,
  type UserRow,
} from "../db/users";
import { requireAuth } from "../middleware/auth";

export const auth = new Hono<AppEnv>();

/** Secrets are typed optional so M0 could deploy before they existed. From
 *  here on their absence is a deployment fault, not a request fault. */
function requireSecret(env: Bindings, name: "JWT_SECRET" | "AUTH_PEPPER"): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is not configured for this environment`);
  return v;
}

async function sessionFor(db: D1Database, user: UserRow): Promise<Session> {
  return {
    user: { id: user.id, email: user.email, created_at: user.created_at },
    spaces: await listMemberships(db, user.id),
  };
}

async function issueTokens(
  env: Bindings,
  user: UserRow,
  deviceLabel: string | null,
): Promise<TokenPair> {
  const refresh = await createSession(env.DB, user.id, deviceLabel);
  return {
    access_token: await signAccessToken(requireSecret(env, "JWT_SECRET"), user.id),
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: refresh.token,
    session: await sessionFor(env.DB, user),
  };
}

/**
 * Step 1 of login: the KDF parameters for an address.
 *
 * Answers for every address, including ones with no account — a 404 here would
 * let anyone test an email list for membership. Unknown addresses get a decoy
 * salt derived deterministically from the address, so repeat probes agree with
 * each other the way a real account's would.
 *
 * The response is genuinely public information: the salt and parameters are
 * needed by any client before it can derive anything, which is why the stored
 * verifier has its own separate, server-generated salt.
 */
auth.post("/auth/kdf", async (c) => {
  const { email } = kdfChallengeSchema.parse(await c.req.json());
  const emailNorm = normalizeEmail(email);

  const user = await findUserByEmail(c.env.DB, emailNorm);
  if (user) {
    return c.json<KdfChallenge>({
      kdf_salt: user.kdf_salt,
      kdf_params: JSON.parse(user.kdf_params) as KdfParams,
    });
  }
  return c.json<KdfChallenge>({
    kdf_salt: await decoyKdfSalt(requireSecret(c.env, "AUTH_PEPPER"), emailNorm),
    kdf_params: DEFAULT_KDF_PARAMS,
  });
});

/**
 * Create an account, its personal space, and default lists.
 *
 * The client generates its own KDF salt here rather than fetching one, which
 * keeps registration to a single round-trip. A client choosing a poor salt only
 * weakens its own account, and the server-generated `verifier_salt` guarantees
 * per-user uniqueness at the layer that is actually stored.
 */
auth.post("/auth/register", async (c) => {
  const body = registerSchema.parse(await c.req.json());
  const emailNorm = normalizeEmail(body.email);
  const pepper = requireSecret(c.env, "AUTH_PEPPER");

  await assertNotLocked(c.env.DB, [ipBucket(clientIp(c.req.raw))]);

  // Registration DOES reveal whether an address is taken. That is unavoidable
  // — the account cannot be created — and it is the one place where the
  // enumeration trade-off falls the other way, because silently succeeding
  // would strand the user with an account they cannot access.
  if (await findUserByEmail(c.env.DB, emailNorm)) {
    throw conflict("An account with that email already exists.");
  }

  const verifierSalt = toBase64(randomBytes(16));
  let verifierHash: string;
  try {
    verifierHash = await computeVerifier(pepper, verifierSalt, body.derived_key);
  } catch {
    throw badRequest("derived_key must be valid base64.");
  }

  const spaceId = crypto.randomUUID();
  const user: UserRow = {
    id: crypto.randomUUID(),
    email: normalizeKey(body.email),
    email_norm: emailNorm,
    kdf_salt: body.kdf_salt,
    kdf_params: JSON.stringify(body.kdf_params),
    verifier_salt: verifierSalt,
    verifier_hash: verifierHash,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  await createUserWithSpace(
    c.env.DB,
    {
      id: user.id,
      email: user.email,
      emailNorm,
      kdfSalt: user.kdf_salt,
      kdfParams: user.kdf_params,
      verifierSalt,
      verifierHash,
      spaceId,
      spaceName: normalizeKey(body.space_name ?? "Personal"),
      now: user.created_at,
    },
    [
      { id: crypto.randomUUID(), name: "Personal", color: "#3b82f6" },
      { id: crypto.randomUUID(), name: "Work", color: "#ef4444" },
    ],
  );

  return c.json<TokenPair>(await issueTokens(c.env, user, null), 201);
});

/**
 * Step 2 of login: exchange a derived key for tokens.
 *
 * Unknown address and wrong password are the same response, and both do the
 * same amount of work — an unknown address still runs a verifier computation
 * against a throwaway value, so the two paths cannot be told apart by timing.
 */
auth.post("/auth/login", async (c) => {
  const body = loginSchema.parse(await c.req.json());
  const emailNorm = normalizeEmail(body.email);
  const pepper = requireSecret(c.env, "AUTH_PEPPER");

  const buckets = [emailBucket(emailNorm), ipBucket(clientIp(c.req.raw))];
  await assertNotLocked(c.env.DB, buckets);

  const user = await findUserByEmail(c.env.DB, emailNorm);

  let ok = false;
  try {
    const salt = user?.verifier_salt ?? (await decoyKdfSalt(pepper, emailNorm));
    const candidate = await computeVerifier(pepper, salt, body.derived_key);
    ok = user ? timingSafeEqual(candidate, user.verifier_hash) : false;
  } catch {
    throw badRequest("derived_key must be valid base64.");
  }

  if (!user || !ok) {
    await recordFailure(c.env.DB, buckets);
    throw unauthorized("That email or password is incorrect.");
  }

  await clearBucket(c.env.DB, emailBucket(emailNorm));
  return c.json<TokenPair>(
    await issueTokens(c.env, user, body.device_label ?? null),
  );
});

/** Rotate a refresh token. See rotateSession for the theft-detection rule. */
auth.post("/auth/refresh", async (c) => {
  const body = refreshSchema.parse(await c.req.json());
  const { refresh, userId } = await rotateSession(c.env.DB, body.refresh_token);

  const user = await findUserById(c.env.DB, userId);
  if (!user) throw unauthorized("Account no longer exists.");

  return c.json<TokenPair>({
    access_token: await signAccessToken(requireSecret(c.env, "JWT_SECRET"), user.id),
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: refresh.token,
    session: await sessionFor(c.env.DB, user),
  });
});

/** Sign out. Always 204, even for an unrecognised token — logout must not
 *  double as a way to test whether a token is valid. */
auth.post("/auth/logout", async (c) => {
  const body = refreshSchema.parse(await c.req.json());
  await revokeByToken(c.env.DB, body.refresh_token);
  return c.body(null, 204);
});

/**
 * The caller's identity and the spaces they can reach.
 *
 * The client calls this on launch to decide whether a stored session is still
 * good, and it is the only place the space list is authoritative — a client
 * must never infer its own membership from a cached token.
 */
auth.get("/auth/me", requireAuth(), async (c) => {
  const user = await findUserById(c.env.DB, c.get("userId"));
  if (!user) throw unauthorized("Account no longer exists.");
  return c.json<Session>(await sessionFor(c.env.DB, user));
});
