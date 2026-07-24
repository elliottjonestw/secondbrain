import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { isTauri } from "../lib/platform";

/**
 * Cloudflare Turnstile widget for the login and register forms.
 *
 * There are TWO gates here, and the split is deliberate — it is what bounds
 * the risk of requiring a captcha on desktop.
 *
 * Registration is the one unauthenticated endpoint a stranger can use to spend
 * a real quota (an account, its seed rows, and a message against a ~100-a-day
 * mail allowance), and the Worker's per-origin exemption is trivially met by a
 * script, which sends no `Origin` at all. So registration now demands a token
 * on EVERY platform, desktop included.
 *
 * Login keeps the old web-only rule. Whether Cloudflare will issue a token to
 * a widget hosted at `tauri://localhost` is unproven — a site key's allowlist
 * is expressed in domains, and a custom scheme has no obvious spelling in one.
 * If it does not work, the damage is confined to new sign-ups on desktop; a
 * user who already has an account can still get in. Extending the requirement
 * to login would turn that same unknown into "nobody can use the desktop app",
 * which is not a bet worth making for a path already protected by the durable
 * failed-attempt throttle.
 *
 * The Worker mirrors this exactly (`turnstileRequiredForRegister`), and has
 * `TURNSTILE_ALLOW_NATIVE=1` as the server-side undo if the bet loses.
 *
 * The site key is public (it identifies the widget to Cloudflare and is meant
 * to ship in the client); the secret half lives only on the Worker.
 */

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** The captcha on LOGIN: web only, and only with a site key configured — so a
 *  dev build or the packaged app never blocks on a widget that isn't there. */
export const TURNSTILE_ENABLED = !isTauri() && !!SITE_KEY;

/** The captcha on REGISTER: every platform, whenever a site key is configured.
 *  An environment with no key still skips it entirely, which is what keeps
 *  local development and unkeyed deploys working. */
export const TURNSTILE_REQUIRED_FOR_REGISTER = !!SITE_KEY;

interface TurnstileApi {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      theme?: "auto" | "light" | "dark";
      callback?: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
    },
  ) => string;
  reset: (id?: string) => void;
  remove: (id: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

/** Load the Turnstile script once, shared across mounts. Resolves when
 *  `window.turnstile` is ready. */
let scriptPromise: Promise<void> | null = null;
function loadScript(): Promise<void> {
  if (typeof window !== "undefined" && window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load the captcha."));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export interface TurnstileHandle {
  /** Discard the current token and re-arm the widget. A Turnstile token is
   *  single-use, so this is called after every failed submit. */
  reset: () => void;
}

interface Props {
  /** Called with a fresh token when the challenge passes, and with `null` when
   *  it expires, errors, or is reset. */
  onVerify: (token: string | null) => void;
}

const Turnstile = forwardRef<TurnstileHandle, Props>(function Turnstile({ onVerify }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  // Keep the latest callback in a ref so the render effect can run exactly once
  // without the caller having to memoise `onVerify`.
  const onVerifyRef = useRef(onVerify);
  onVerifyRef.current = onVerify;

  useImperativeHandle(ref, () => ({
    reset() {
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.reset(widgetIdRef.current);
        onVerifyRef.current(null);
      }
    },
  }));

  useEffect(() => {
    let cancelled = false;
    void loadScript()
      .then(() => {
        if (cancelled || widgetIdRef.current || !containerRef.current || !window.turnstile) return;
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: SITE_KEY!,
          theme: "auto",
          callback: (token) => onVerifyRef.current(token),
          "expired-callback": () => onVerifyRef.current(null),
          "error-callback": () => onVerifyRef.current(null),
        });
      })
      .catch(() => onVerifyRef.current(null));

    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, []);

  return <div ref={containerRef} className="flex justify-center" />;
});

export default Turnstile;
