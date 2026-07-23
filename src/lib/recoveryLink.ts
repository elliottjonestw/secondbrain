/**
 * Reading the one-time token out of a reset or confirmation link.
 *
 * The token travels in the URL **fragment** (`#reset=…`, `#verify=…`), not the
 * query string, and that is a security property rather than a style choice: a
 * fragment is never sent to a server and never appears in a `Referer` header,
 * so the token can't reach GitHub Pages' access logs, any third-party script
 * the page loads, or whatever site the user visits next. The Worker mints the
 * links in this shape; see `worker/src/auth/email.ts`.
 */

export interface RecoveryLink {
  kind: "reset" | "verify";
  token: string;
}

/**
 * Take the token, if there is one, and scrub it from the address bar.
 *
 * "Take" is the operative word — it is removed as it is read, via
 * `replaceState` so it doesn't survive in the back stack either. Leaving it in
 * place would keep a live credential visible over the user's shoulder, and
 * would re-trigger the flow on every reload, which for a single-use token means
 * the second attempt fails and looks like the link was broken.
 *
 * Call this exactly once, at startup. It is idempotent only in that the second
 * call returns null.
 */
export function takeRecoveryLink(): RecoveryLink | null {
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash) return null;

  const params = new URLSearchParams(hash);
  const reset = params.get("reset");
  const verify = params.get("verify");
  if (!reset && !verify) return null;

  window.history.replaceState(null, "", window.location.pathname + window.location.search);

  return reset ? { kind: "reset", token: reset } : { kind: "verify", token: verify! };
}
