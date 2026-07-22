-- Throttling for the auth endpoints.
--
-- The client-side KDF (see 0001's users comment) makes each login guess cost
-- the ATTACKER ~100 ms of their own CPU, which is meaningful friction but not
-- a rate limit: it is parallelisable across machines and does nothing to stop
-- a slow, patient online guessing campaign against one known address.
--
-- Counters live in D1 rather than in a Durable Object because a DO per address
-- is a per-object cost for something that is almost always empty, and rather
-- than in Cloudflare's rate-limiting binding because that is configured per
-- deployment and cannot express "lock this one account for 15 minutes".
--
-- One row per bucket, and buckets are coarse on purpose: 'email:<norm>' and
-- 'ip:<addr>'. Rows are self-expiring in the sense that a stale window_start
-- resets the count on next write, so no cleanup job is needed; a periodic
-- delete of old rows is a housekeeping nicety, not a correctness requirement.
CREATE TABLE auth_throttle (
  bucket       TEXT PRIMARY KEY,   -- 'email:<email_norm>' | 'ip:<address>'
  fails        INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL,      -- ISO; a window older than the limit resets fails
  locked_until TEXT                -- ISO; set once fails crosses the threshold
);
