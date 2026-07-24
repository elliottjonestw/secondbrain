-- Durable daily budgets for the things that spend a finite external quota.
--
-- This is the THIRD limiter in the codebase, and it exists because neither of
-- the other two can express what it does:
--
--   * `auth_throttle` (0002) counts FAILURES and locks one account or address.
--     It is never touched by a successful call, so a registration spammer —
--     who never fails anything — leaves it permanently empty.
--   * Cloudflare's rate-limiting binding counts SUCCESSES in-colo in about a
--     millisecond, which is why the proxy routes use it. But its `period` may
--     only be 10 or 60 SECONDS. Even a strict 5-per-minute cap still permits
--     7,200 registrations a day from one address, and the Resend free tier is
--     100 messages a day. A binding physically cannot bound a day.
--
-- So: one row per bucket, counting successes over a calendar day, in D1. The
-- ~105 ms round-trip that rules D1 out for the hot relay routes is irrelevant
-- here — every caller of this table is a rare event (an email being sent, an
-- image being uploaded), never a per-keystroke or per-refresh path.
--
-- `window_start` holds a date ('YYYY-MM-DD', UTC), not a timestamp, and a row
-- whose date is behind today resets its count on the next write. That is what
-- keeps this table from growing without bound: a bucket is reused across days
-- rather than minted per day, so the row count is bounded by the number of
-- distinct addresses seen, not by that times the number of days. No cleanup
-- job is required; deleting stale rows is housekeeping, not correctness.
--
-- Deliberately NOT keyed by user id anywhere: every bucket here guards an
-- external quota that is shared by the whole deployment, so the interesting
-- questions are "how much has this IP spent today" and "how much has this
-- WORKER spent today". The second one is the circuit breaker — no combination
-- of endpoints, addresses or IPs can push outbound mail past it.
CREATE TABLE quota (
  bucket       TEXT PRIMARY KEY,  -- 'mail:global' | 'mail:ip:<addr>' | 'img:<user_id>'
  used         INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL      -- 'YYYY-MM-DD' UTC; an older date resets `used`
);
