import { Hono } from "hono";
import type { AppEnv } from "../env";
import { clientIp } from "../auth/throttle";
import { enforceRateLimit } from "../rateLimit";

export const health = new Hono<AppEnv>();

/**
 * Liveness + D1 reachability.
 *
 * It runs a real query against a real table rather than `SELECT 1`, so it also
 * answers "have the migrations been applied to the database this environment is
 * bound to?" — the failure this project is most likely to hit when promoting
 * from local to staging, and one that `SELECT 1` reports as healthy.
 */
health.get("/health", async (c) => {
  // Public, unauthenticated, and it runs a real query by design — which makes
  // an uncapped health check a free D1-read generator for anyone who finds the
  // URL. Keyed by IP since there is no identity here. Any real monitor polls
  // at most once a minute, so this is invisible to legitimate use.
  await enforceRateLimit(
    c.env.HEALTH_LIMIT,
    `health:${clientIp(c.req.raw)}`,
    "Too many requests.",
  );

  const started = Date.now();
  try {
    const row = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM spaces",
    ).first<{ n: number }>();

    return c.json({
      status: "ok",
      environment: c.env.ENVIRONMENT,
      database: { reachable: true, spaces: row?.n ?? 0, ms: Date.now() - started },
    });
  } catch (err) {
    // Deliberately not a throw: a health check that 500s tells you less than
    // one that reports which half is broken.
    console.error("health: database unreachable", {
      requestId: c.get("requestId"),
      err,
    });
    return c.json(
      {
        status: "degraded",
        environment: c.env.ENVIRONMENT,
        database: {
          reachable: false,
          hint: "Have the migrations been applied? `npm run migrate:local -w worker`",
        },
      },
      503,
    );
  }
});
