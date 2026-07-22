/**
 * The API's error vocabulary.
 *
 * Every non-2xx response has this exact body shape, so the client never has to
 * parse prose to decide what happened. `code` is the thing to branch on; the
 * message is for humans and may change.
 */

export const ERROR_CODES = [
  "bad_request",       // malformed body / failed schema validation
  "unauthorized",      // missing, expired or invalid access token
  "forbidden",         // authenticated, but not a member of that space
  "not_found",         // no such row, OR a row in a space you can't see
  "conflict",          // uniqueness violation (duplicate list/tag name)
  "precondition",      // ETag / If-Match mismatch — a genuine concurrent edit
  "rate_limited",
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    /** Field-level detail from schema validation; absent otherwise. */
    fields?: Record<string, string>;
  };
}

/**
 * `not_found` is deliberately returned for rows that exist in a space the
 * caller cannot see, rather than `forbidden`. `forbidden` would confirm the id
 * is real, which turns the API into an existence oracle for other tenants'
 * data. Reserve `forbidden` for spaces the caller knows about but lacks the
 * role for.
 */
export const HTTP_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  precondition: 412,
  rate_limited: 429,
  internal: 500,
};
