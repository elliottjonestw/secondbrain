import { Hono } from "hono";
import type { AppEnv } from "../env";

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
