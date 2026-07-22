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

  constructor(code: ErrorCode, message: string, fields?: Record<string, string>) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.fields = fields;
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
