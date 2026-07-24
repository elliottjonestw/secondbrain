import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";

/**
 * Response hardening for the API itself.
 *
 * This is a JSON API plus one binary route; nothing it returns is ever meant to
 * be rendered, framed or interpreted as a document. These headers say so, which
 * matters because "never rendered" is an intention, not a guarantee — an image
 * endpoint that streams whatever bytes a user uploaded is precisely the shape
 * that turns into stored XSS the first time a browser decides an upload is
 * really HTML.
 *
 *  - `nosniff` is the load-bearing one. Without it a browser may ignore our
 *    `Content-Type` and sniff, so a note image containing `<script>` can be
 *    executed on this origin.
 *  - `default-src 'none'` gives that path a second, independent floor: even if
 *    a response were treated as a document, it can load and run nothing.
 *  - `frame-ancestors 'none'` (and `X-Frame-Options` for older engines) means a
 *    response can't be embedded and clickjacked.
 *  - `Referrer-Policy: no-referrer` stops our own URLs — which contain space
 *    and item ids — reaching anywhere the user navigates next.
 *  - `Strict-Transport-Security` pins HTTPS for six months. Workers are always
 *    served over TLS, so this is defense-in-depth: on a first visit (or behind a
 *    transparent proxy that strips the scheme) it stops an active MITM
 *    downgrading the login `derived_key` — a password-equivalent — on the wire.
 *
 * They are set AFTER `next()` so they land on error responses too. The one
 * thing to be careful of is CORS: this must never overwrite what the cors
 * middleware set, which is why nothing here touches an `Access-Control-*`
 * header. The web build reads image bytes cross-origin, so `Cross-Origin-
 * Resource-Policy` is `cross-origin` — `same-site` would block github.io
 * reading workers.dev and break every image in the web app.
 */
export function securityHeaders(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    c.header("Cross-Origin-Resource-Policy", "cross-origin");
    c.header("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
    c.header("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  };
}
