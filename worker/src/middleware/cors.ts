import { cors } from "hono/cors";
import type { MiddlewareHandler } from "hono";
import type { AppEnv, Bindings } from "../env";

/**
 * CORS against an allowlist read from the environment.
 *
 * Two things make this less boilerplate than it looks:
 *
 *  * The allowlist has to be an env var, not a constant, because the allowed
 *    origins genuinely differ per environment and per platform. Tauri's webview
 *    origin is `tauri://localhost` on macOS and iOS but `http://tauri.localhost`
 *    on Windows and Android — hard-coding either one ships an app that works on
 *    half its targets and fails CORS on the rest.
 *
 *  * `credentials` is deliberately NOT enabled. Auth travels in an
 *    `Authorization: Bearer` header, not a cookie (the Tauri webview's cookie
 *    jar isn't shared with plugin-http's fetch, and mobile compounds it), so
 *    there is nothing for the browser to attach and no reason to widen the
 *    policy.
 */
export function corsMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const allowed = parseOrigins(c.env);
    const handler = cors({
      // A function, not a list: it runs per-request, so it can echo back the
      // matched origin rather than a wildcard. `*` would be simpler and is
      // wrong here — it forbids credentials outright and makes the allowlist
      // decorative.
      origin: (origin) => (origin && allowed.includes(origin) ? origin : null),
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "If-None-Match", "If-Match"],
      // Headers a browser build must be able to read off a response. ETag for
      // future conditional revalidation; the image dimensions so NoteImage can
      // size the <img> before decode; Retry-After so a rate-limited caller that
      // can genuinely wait (the restore's image loop) knows how long, instead of
      // guessing and hammering the limiter. (In Tauri, plugin-http isn't subject
      // to CORS, so this only matters for the web build.)
      exposeHeaders: ["ETag", "X-Image-Width", "X-Image-Height", "Retry-After"],
      maxAge: 86400,
    });
    return handler(c, next);
  };
}

function parseOrigins(env: Bindings): string[] {
  return (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
