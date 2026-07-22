import { Hono } from "hono";
import { ZodError } from "zod";
import type { AppEnv } from "./env";
import { ApiError } from "./http";
import { corsMiddleware } from "./middleware/cors";
import { health } from "./routes/health";
import { auth } from "./routes/auth";
import { spaces } from "./routes/spaces";
import { quotes } from "./routes/quotes";
import { dav } from "./routes/dav";

/**
 * Second Brain API.
 *
 * Every route lives under /v1. The version prefix exists because published
 * desktop builds are not force-upgradable — an installed copy keeps calling
 * whatever it was built against, so a breaking change has to be able to live
 * alongside the old shape rather than replace it.
 */
const app = new Hono<AppEnv>();

// A correlation id on every request and every error response, so a user
// reporting "it failed" hands over one string that finds the log line.
app.use("*", async (c, next) => {
  c.set("requestId", crypto.randomUUID());
  await next();
  c.header("X-Request-Id", c.get("requestId"));
});

app.use("*", corsMiddleware());

app.route("/v1", health);
app.route("/v1", auth);
app.route("/v1", spaces);
app.route("/v1", quotes);
app.route("/v1", dav);

app.notFound((c) =>
  c.json({ error: { code: "not_found", message: "No such endpoint." } }, 404),
);

/**
 * The single error boundary.
 *
 * Unrecognized throws become a bare 500 with no detail: an exception message
 * from a D1 driver can quote the failing SQL, and that SQL can contain another
 * tenant's data. The detail goes to the logs, never to the client.
 */
app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json(err.toBody(), err.status);
  }

  // Schema validation that escaped a route's own handling.
  if (err instanceof ZodError) {
    const fields: Record<string, string> = {};
    for (const issue of err.issues) fields[issue.path.join(".") || "_"] = issue.message;
    return c.json(
      { error: { code: "bad_request", message: "Invalid request.", fields } },
      400,
    );
  }

  console.error("unhandled", { requestId: c.get("requestId"), err });
  return c.json(
    { error: { code: "internal", message: "Something went wrong." } },
    500,
  );
});

export default app;
