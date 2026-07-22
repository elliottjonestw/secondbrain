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
 * Inside Tauri the webview's own `fetch` is subject to CORS from
 * `tauri://localhost`, so requests must go through the HTTP plugin — and the
 * Worker's origin has to be in `capabilities/default.json`. On web and mobile
 * builds the native `fetch` is correct and the plugin isn't available, which is
 * why this is resolved at runtime rather than imported at the top.
 */
async function platformFetch(input: string, init: RequestInit): Promise<Response> {
  if (isTauri()) {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    return tauriFetch(input, init);
  }
  return fetch(input, init);
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

  constructor(code: ErrorCode, message: string, status: number, fields?: Record<string, string>) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.fields = fields;
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /** Auth endpoints that must not trigger the refresh-and-retry loop. */
  anonymous?: boolean;
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
  const { method = "GET", body, anonymous = false } = options;

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
      });
    } catch {
      // fetch only rejects on a transport failure — DNS, refused connection,
      // no network. An HTTP error status resolves normally.
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
    throw new ApiError(code, message, res.status, fields);
  }

  return (await res.json()) as T;
}
