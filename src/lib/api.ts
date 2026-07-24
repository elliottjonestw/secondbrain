import type { ApiErrorBody, ErrorCode } from "@secondbrain/shared";
import { isTauri } from "./platform";
import {
  clearAuth,
  getAccessToken,
  getRefreshToken,
  setAccessToken,
  setRefreshToken,
} from "./authStore";

/**
 * The single path from this app to the Worker.
 *
 * Everything above it — db.ts, ai.ts, views — calls typed helpers, never
 * `fetch` directly, so auth headers, token refresh, offline detection and
 * error shape are decided once.
 */

const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8787";

/**
 * A request that outruns this is treated as a network failure, not left
 * hanging. Neither the web `fetch` nor the HTTP plugin imposes any deadline of
 * its own, so a connection that goes stale while the page sits idle — a laptop
 * that slept, a network that changed — leaves a request pending for the
 * browser's own multi-minute default. That is exactly what surfaced as a
 * "still loading…" banner that never cleared: the first-load gate gives up
 * blocking after 8s and shows the banner, but the request behind it never
 * settles to take the banner back down. A bounded timeout turns that into an
 * OfflineError, which resolves to a retry page instead. Longer than the gate's
 * 8s so a genuinely slow-but-alive connection still completes.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Inside Tauri the webview's own `fetch` is subject to CORS from
 * `tauri://localhost`, so requests must go through the HTTP plugin — and the
 * Worker's origin has to be in `capabilities/default.json`. On web and mobile
 * builds the native `fetch` is correct and the plugin isn't available, which is
 * why this is resolved at runtime rather than imported at the top.
 *
 * Every request is bounded by REQUEST_TIMEOUT_MS. A caller-supplied signal (a
 * search box aborting a superseded request) is chained into the same controller
 * so either cause aborts the fetch; the timeout aborts with a TimeoutError,
 * which callers map to OfflineError, while a caller abort keeps its AbortError
 * so it stays distinguishable.
 */
async function platformFetch(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("Request timed out", "TimeoutError")),
    REQUEST_TIMEOUT_MS,
  );

  const caller = init.signal;
  if (caller) {
    if (caller.aborted) controller.abort(caller.reason);
    else caller.addEventListener("abort", () => controller.abort(caller.reason), { once: true });
  }

  const merged: RequestInit = { ...init, signal: controller.signal };
  try {
    if (isTauri()) {
      const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
      return await tauriFetch(input, merged);
    }
    return await fetch(input, merged);
  } finally {
    clearTimeout(timer);
  }
}

/** A request that failed before reaching the server. Distinct from an HTTP
 *  error so callers can say "you're offline" rather than "something broke". */
export class OfflineError extends Error {
  constructor() {
    super("You're offline. Changes can't be saved until you reconnect.");
    this.name = "OfflineError";
  }
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fields?: Record<string, string>;
  /** Seconds the server asked us to wait, from `Retry-After`. Only a
   *  rate-limited response carries one, and only a caller that can genuinely
   *  wait (the backup restore's image loop) should act on it — everything else
   *  shows the message and lets the user decide. */
  readonly retryAfter?: number;

  constructor(
    code: ErrorCode,
    message: string,
    status: number,
    fields?: Record<string, string>,
    retryAfter?: number,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.fields = fields;
    this.retryAfter = retryAfter;
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /** Auth endpoints that must not trigger the refresh-and-retry loop. */
  anonymous?: boolean;
  /** Cancels the request. Search boxes debounce and then abort the previous
   *  in-flight call; without this an older, slower response can land last and
   *  overwrite the newer one. */
  signal?: AbortSignal;
}

/**
 * Refresh is deduplicated through a module-level promise.
 *
 * Several requests routinely discover an expired token in the same tick — five
 * Today widgets loading at once, say. Without this they would each rotate the
 * refresh token, and because rotation is single-use, the second one to land
 * would look like token reuse and revoke the entire session family. The bug
 * would present as "the app randomly signs me out", which is exactly the kind
 * of thing that takes days to trace.
 */
let refreshInFlight: Promise<void> | null = null;

async function refreshAccessToken(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const refresh = getRefreshToken();
    if (!refresh) throw new ApiError("unauthorized", "Sign in to continue.", 401);

    let res: Response;
    try {
      res = await platformFetch(`${BASE_URL}/v1/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refresh }),
      });
    } catch {
      throw new OfflineError();
    }

    if (!res.ok) {
      // The refresh token is dead — revoked, rotated, or expired. Nothing the
      // client can do but sign in again.
      clearAuth();
      throw new ApiError("unauthorized", "Your session has ended. Sign in again.", 401);
    }

    const data = (await res.json()) as { access_token: string; expires_in: number; refresh_token: string };
    setAccessToken(data.access_token, data.expires_in);
    setRefreshToken(data.refresh_token);
  })();

  try {
    await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, anonymous = false, signal } = options;

  if (!anonymous && !getAccessToken()) await refreshAccessToken();

  const send = async (): Promise<Response> => {
    const token = anonymous ? null : getAccessToken();
    try {
      return await platformFetch(`${BASE_URL}${path}`, {
        method,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      // A caller abort (a search box moving on) is the caller's own doing, not
      // a network failure — reporting it as OfflineError would put a spurious
      // "you're offline" banner on screen. Key off the caller's own signal
      // rather than the error's name, so the timeout abort — which the plugin
      // may surface as a plain AbortError — isn't mistaken for one.
      if (signal?.aborted) throw e;
      // Everything else is a transport failure — DNS, refused connection, no
      // network, or our own timeout firing on a stalled connection. An HTTP
      // error status resolves normally and never lands here.
      throw new OfflineError();
    }
  };

  let res = await send();

  // One retry: the token can lapse between the pre-flight check and the server
  // reading it, and a server restart invalidates nothing but is worth surviving.
  if (res.status === 401 && !anonymous) {
    await refreshAccessToken();
    res = await send();
  }

  if (res.status === 204) return undefined as T;

  if (!res.ok) {
    let code: ErrorCode = "internal";
    let message = "Something went wrong.";
    let fields: Record<string, string> | undefined;
    try {
      const parsed = (await res.json()) as ApiErrorBody;
      if (parsed?.error) {
        code = parsed.error.code;
        message = parsed.error.message;
        fields = parsed.error.fields;
      }
    } catch {
      // A non-JSON error body means something upstream of the Worker failed —
      // keep the generic message rather than surfacing raw HTML.
    }
    throw new ApiError(code, message, res.status, fields, retryAfterSeconds(res));
  }

  return (await res.json()) as T;
}

/** `Retry-After` in seconds, when the server sent a sane one. The HTTP-date
 *  form is legal but nothing here emits it, so a non-numeric value is ignored
 *  rather than parsed. Capped so a hostile or broken header can't park a caller
 *  for an hour. */
function retryAfterSeconds(res: Response): number | undefined {
  const raw = Number(res.headers.get("Retry-After"));
  if (!Number.isFinite(raw) || raw <= 0) return undefined;
  return Math.min(raw, 120);
}

/**
 * A GET whose body is binary (a note image), returning the bytes plus response
 * headers. Same auth + one-retry flow as apiRequest, but it reads a Blob rather
 * than JSON. Errors still arrive as JSON, so a non-2xx is parsed like anywhere
 * else. Always authenticated — images are never anonymous.
 */
export async function apiGetBinary(path: string): Promise<{ blob: Blob; headers: Headers }> {
  if (!getAccessToken()) await refreshAccessToken();

  const send = async (): Promise<Response> => {
    const token = getAccessToken();
    try {
      return await platformFetch(`${BASE_URL}${path}`, {
        method: "GET",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch {
      throw new OfflineError();
    }
  };

  let res = await send();
  if (res.status === 401) {
    await refreshAccessToken();
    res = await send();
  }

  if (!res.ok) {
    let code: ErrorCode = "internal";
    let message = "Something went wrong.";
    try {
      const parsed = (await res.json()) as ApiErrorBody;
      if (parsed?.error) {
        code = parsed.error.code;
        message = parsed.error.message;
      }
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(code, message, res.status);
  }

  return { blob: await res.blob(), headers: res.headers };
}
