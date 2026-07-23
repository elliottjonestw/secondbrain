import type { Bindings } from "../env";
import { clientIp } from "./throttle";

/**
 * Cloudflare Turnstile — the bot check in front of register and login.
 *
 * The design decision this file encodes: the check is WEB-ONLY, enforced by the
 * server per origin. Turnstile is a browser widget (a script plus an iframe from
 * challenges.cloudflare.com), so it only exists on the web build served from
 * github.io. The desktop app serves from `tauri://localhost`, can't render the
 * widget, and its native http-plugin requests carry no `Origin` header at all —
 * so it is exempt.
 *
 * The known limitation of "web-only, per-origin" is that a script hitting the
 * public API directly with no Origin header is treated like the desktop app and
 * skips the check. That is an accepted trade: it still stops the realistic
 * threat, which is automated abuse of the visible web sign-up form, and closing
 * it entirely would mean making the widget work inside the Tauri webview (its
 * own referrer/origin minefield — see the YouTube note in CLAUDE.md).
 */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** The Tauri webview's origins — `tauri://localhost` on macOS/iOS,
 *  `http://tauri.localhost` on Windows/Android. Requests from these are the
 *  desktop app and never carry a Turnstile token. */
const TAURI_ORIGINS = new Set(["tauri://localhost", "http://tauri.localhost"]);

/**
 * Whether this request must pass a Turnstile challenge.
 *
 * True only when the secret is configured AND the request comes from a browser
 * origin. A missing `Origin` (native http-plugin calls send none) or a Tauri
 * origin is the desktop app: exempt. An unset secret disarms the check for the
 * whole environment.
 */
export function turnstileRequired(env: Bindings, req: Request): boolean {
  if (!env.TURNSTILE_SECRET_KEY) return false;
  const origin = req.headers.get("Origin");
  if (!origin) return false;
  return !TAURI_ORIGINS.has(origin);
}

/**
 * Verify a token against Cloudflare's siteverify endpoint.
 *
 * Returns false — never throws — for a missing token, a network failure, or a
 * rejection, so a callers can uniformly answer "captcha failed, try again"
 * rather than distinguishing bot from outage. `remoteip` is sent as an extra
 * signal Cloudflare can weigh; it is best-effort and omitted if unknown.
 */
export async function verifyTurnstile(
  secret: string,
  token: string | undefined,
  req: Request,
): Promise<boolean> {
  if (!token) return false;

  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  const ip = clientIp(req);
  // clientIp falls back to "local" when CF-Connecting-IP is absent (dev); only
  // pass a real edge-provided address as the optional signal.
  if (ip !== "local") form.append("remoteip", ip);

  try {
    const res = await fetch(SITEVERIFY_URL, { method: "POST", body: form });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}
