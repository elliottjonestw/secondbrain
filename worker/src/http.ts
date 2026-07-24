import { HTTP_STATUS, type ApiErrorBody, type ErrorCode } from "@secondbrain/shared";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * The one way this API reports failure.
 *
 * Routes throw `ApiError` rather than returning ad-hoc responses, so the shape
 * the client parses is decided in a single place and cannot drift per-endpoint.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly fields?: Record<string, string>;
  /**
   * Seconds until the caller may retry, rendered as `Retry-After` by the error
   * boundary in index.ts.
   *
   * Only the rate limiters set it. It carries the *window*, never the budget:
   * telling a caller how long to wait is what an honest client needs to back
   * off correctly, while telling it how many calls it gets is telling an
   * abusive one exactly how to pace itself just under the line.
   */
  readonly retryAfter?: number;

  constructor(
    code: ErrorCode,
    message: string,
    fields?: Record<string, string>,
    retryAfter?: number,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.fields = fields;
    this.retryAfter = retryAfter;
  }

  get status(): ContentfulStatusCode {
    return HTTP_STATUS[this.code] as ContentfulStatusCode;
  }

  toBody(): ApiErrorBody {
    return { error: { code: this.code, message: this.message, ...(this.fields ? { fields: this.fields } : {}) } };
  }
}

export const badRequest = (message: string, fields?: Record<string, string>) =>
  new ApiError("bad_request", message, fields);
export const unauthorized = (message = "Sign in to continue.") =>
  new ApiError("unauthorized", message);
export const forbidden = (message = "You don't have access to that.") =>
  new ApiError("forbidden", message);
export const notFound = (message = "Not found.") => new ApiError("not_found", message);
export const conflict = (message: string) => new ApiError("conflict", message);
