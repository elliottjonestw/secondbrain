-- Password reset, email verification, and the flag both hang off.
--
-- A reset has to work without the server ever learning a password, which is the
-- property the whole auth design rests on (see docs/cloud-migration-plan.md
-- §5.1). So a token here does not authorise "change this password" — it
-- authorises "replace this account's kdf_salt, kdf_params and verifier with a
-- set the client computed". The client derives a NEW key from the new password
-- under a NEW salt and sends only that, exactly as registration does.
--
-- Tokens are stored HASHED, for the same reason refresh tokens are: a D1 dump
-- must not hand anyone a working reset link. The hash is the primary key, so
-- lookup is by the only thing the server can compute from what the user
-- presents, and there is no index on a plaintext secret to leak.
--
-- `used_at` rather than DELETE-on-use: a consumed token that still exists is
-- how a replay is recognised as a replay instead of looking like an expired
-- one. Rows are pruned opportunistically when a user requests a new token, so
-- no cleanup job is needed.

CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY,      -- sha256(token), base64
  user_id    TEXT NOT NULL,
  expires_at TEXT NOT NULL,         -- ISO; short (30 min) by design
  used_at    TEXT,                  -- ISO once redeemed; single-use
  created_at TEXT NOT NULL
);

-- Issuing a token prunes that user's old ones, and deleting an account clears
-- them; both look the row up by user, not by hash.
CREATE INDEX idx_password_resets_user ON password_resets(user_id);

-- Verification carries `email_norm` so a token issued for one address cannot
-- confirm a different one if the address is ever changed between issue and
-- click. The check is cheap and the alternative is a silent mis-confirmation.
CREATE TABLE email_verifications (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  email_norm TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_email_verifications_user ON email_verifications(user_id);

-- NULL for every account that predates verification, which is deliberate: it
-- reads as "unverified", and unverified is a prompt in Settings rather than a
-- locked door. Making it a login precondition would have signed out every
-- existing user at deploy time.
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
