# Sekunda API (Cloudflare Worker)

The backend half of the cloud migration — see [`docs/cloud-migration-plan.md`](../docs/cloud-migration-plan.md)
for the full plan and the reasoning behind each decision.

**Status: complete through M5 (hardening).** Auth plus every domain — todos,
lists, reminders, people, events, notes (with trigram FTS), tags, links, note
images, and backup/export — is served from here, along with password reset,
email confirmation, account deletion, per-user limits on the proxy routes and
hardening headers on every response.

One thing to know before deploying M5: **the reset and confirmation endpoints
need `RESEND_API_KEY`** (`npx wrangler secret put RESEND_API_KEY --env …`).
Without it they refuse identically for every address — deliberately, since a
response that varied with whether an account exists is the existence oracle the
whole flow is designed to avoid. The operator sees the failure in
`wrangler tail`; the caller cannot.

## Local development

Nothing here touches your Cloudflare account. `wrangler dev` runs D1 under
Miniflare against `.wrangler/state`, so the whole stack works offline and the
local database is disposable.

```bash
npm install                  # from the repo root; workspaces install all three
npm run worker:migrate       # apply migrations to the local D1
npm run worker:dev           # http://localhost:8787
curl http://localhost:8787/v1/health
```

A healthy response proves three things at once — the Worker booted, the D1
binding resolved, and the migrations have been applied to *this* environment's
database:

```json
{"status":"ok","environment":"development","database":{"reachable":true,"spaces":0,"ms":12}}
```

A `503` with `"reachable": false` almost always means the migration step was
skipped. That's why the check queries a real table instead of `SELECT 1`, which
would report an unmigrated database as healthy.

## Deployed environments

Both are live, in region APAC, each with its **own** D1 database, KV namespace
and secrets — nothing is shared, so a staging account does not exist in
production and test data cannot reach real data.

| | URL | D1 | KV |
| --- | --- | --- | --- |
| Staging | `secondbrain-api-staging.elliottj.workers.dev` | `secondbrain-staging` | `239ecd43…` |
| Production | `secondbrain-api.elliottj.workers.dev` | `secondbrain-prod` | `5f4698a4…` |

Migrations through `0003` are applied to both; `JWT_SECRET` and `AUTH_PEPPER`
are set on both. Packaged builds point at **production** via `.env.production`.

**Never re-run `wrangler secret put AUTH_PEPPER`** on an environment that has
users. It is mixed into every stored password verifier, so changing it doesn't
sign people out — it locks every account out permanently, with no recovery path
short of deleting the users. `JWT_SECRET` is safe to rotate (it only signs
everyone out).

Measured on staging from the same region as the primary: ~92 ms for a health
query, ~170 ms wall clock per request end to end, ~900 ms for a 500-row import
batch. Treat query *count* as the latency budget.

## First-time Cloudflare setup

These commands create resources on your account. Everything here stays on the
free plan, which fails closed with quota errors rather than billing an
overage — **keep the account card-free and that property holds**.

```bash
npx wrangler login

# Pick the primary region deliberately. D1 has a single primary, and every
# write plus every non-replicated read pays the round-trip to it. Choose the
# one nearest you: weur, eeur, apac, wnam, enam, oc.
npx wrangler d1 create secondbrain-staging --location apac
npx wrangler d1 create secondbrain-prod    --location apac

# KV namespaces for note-image bytes. Locally these aren't needed —
# `wrangler dev` simulates KV — but a remote deploy is.
#
# KV rather than R2 specifically because enabling R2 requires a payment method
# on the account even for its free tier. Keep this account CARD-FREE: every
# product here (Workers, D1, KV) then fails closed with a quota error instead of
# billing an overage, so an abusive spike can cost availability but never money.
# Adding a card to enable a paid product gives that up account-wide.
npx wrangler kv namespace create IMAGES --env staging
npx wrangler kv namespace create IMAGES --env production
```

Paste each returned `database_id` and KV namespace `id` into the matching block
in `wrangler.toml`, then:

Then, **in this order** — `wrangler secret put` fails with "Worker not found"
until the Worker exists, so the first deploy has to come before the secrets:

```bash
# from the repo root
npm run migrate:staging -w @secondbrain/worker     # create the tables
npm run deploy:staging  -w @secondbrain/worker     # creates the Worker itself

# from worker/ — these read wrangler.toml directly, so the directory matters.
# Run from anywhere else and wrangler reports "No environment found in
# configuration with name staging", which looks like a config bug and isn't.
cd worker
openssl rand -base64 48 | pbcopy   # save to a password manager BEFORE pasting
npx wrangler secret put JWT_SECRET  --env staging
openssl rand -base64 48 | pbcopy
npx wrangler secret put AUTH_PEPPER --env staging
cd ..

npm run deploy:staging  -w @secondbrain/worker     # redeploy so it picks them up
```

Secrets are **write-only** — there is no way to read one back from Cloudflare or
the dashboard, and `wrangler secret list` shows names only. The moment you
generate a value is the only chance to keep a copy.

Deploying before the secrets exist is safe — they are typed optional precisely
so this bootstrap order compiles — but auth will 500 until they are set.

> **`AUTH_PEPPER` must be set once and never rotated.** `JWT_SECRET` can be
> rotated freely — it just signs everyone out. Rotating `AUTH_PEPPER`
> invalidates every stored password verifier, which locks every account out
> permanently with no recovery path.

## Running on the free plan

This is designed for the Workers free plan. The one place that genuinely
constrains the design is password hashing, and it is worth understanding before
touching `src/auth/`.

The free plan caps **CPU at 10 ms per request**. A correctly tuned argon2id hash
costs 50–150 ms *by design* — that cost is the entire defence against offline
cracking, so shrinking it to fit would be a real loss of security. Instead the
expensive step runs on the user's own device, which isn't metered:

```
client:  dk = argon2id(password, kdf_salt, kdf_params)      ~100 ms
wire:    dk                                                  over TLS
server:  sha256(verifier_salt || dk || AUTH_PEPPER)          ~0.01 ms CPU
```

Same architecture as Bitwarden and 1Password. An attacker holding the `users`
table still has to run the full argon2id per guess, so offline resistance is
unchanged; and the server never sees a plaintext password, so one can't leak
through a log.

**The one fatal mistake to avoid: never store `dk` raw.** It is
password-equivalent — storing it would make a database dump directly replayable
as a login. The server-side hash exists solely to prevent that.

Other free-plan ceilings, none of which bite at this project's scale:

| Limit | Free plan |
| --- | --- |
| Worker CPU | 10 ms/request |
| Worker requests | 100,000/day |
| D1 rows read | 5,000,000/day — counts rows **scanned**, not returned |
| D1 rows written | 100,000/day |
| D1 storage | 5 GB |
| KV storage | 1 GB total |
| KV reads | 100,000/day |
| KV writes / deletes | 1,000/day each |

The rows-read rule is why `space_id` leads every index in `0001_init.sql`: an
unindexed query burns quota proportional to table size, so a full scan is no
longer merely slow, it is metered.

## Layout

```
migrations/0001_init.sql   squashed local 001–007 + multi-tenancy
           0002_*.sql      auth throttling
           0003_*.sql      note_images.r2_key -> blob_key (R2 -> KV)
           0004_*.sql      password reset + email confirmation tokens
src/index.ts               Hono app, error boundary, /v1 mount
src/env.ts                 bindings + request-scoped variables
src/http.ts                ApiError — the single failure shape
src/authorize.ts           the ONE access-control choke point
src/rateLimit.ts           per-user caps on the proxy routes
src/auth/                  crypto · tokens · throttle (failed logins) · email
src/middleware/            cors (per-environment allowlist) · auth ·
                           securityHeaders
src/routes/                health · auth · spaces (all domain endpoints) ·
                           quotes + dav (the two narrow proxies)
src/db/                    the ONLY place SQL is written — one file per domain,
                           plus backup.ts (logical export/import/wipe),
                           recovery.ts (reset/confirm tokens) and
                           account.ts (deletion)
scripts/loadcheck.mjs      latency sanity-check; `npm run loadcheck -w @secondbrain/worker`
```

### Two limiters, on purpose

`auth_throttle` (migration 0002) counts **failures** against an account and
locks it — durable, globally consistent state, worth a D1 round-trip because it
runs at most once per sign-in. `rateLimit.ts` counts **successes** on hot paths
(a calendar refresh is dozens of relayed requests) using Cloudflare's in-colo
rate-limiting binding, because a D1 hop per call would be the dominant cost of
the feature. The in-colo counter is per-datacentre rather than global; see the
comment in `rateLimit.ts` for why that's the right trade here.

## Rules for this Worker

- **All SQL lives in `src/db/`** (from M2). Routes call helpers; they never
  write queries inline. This is the same constraint the client's `db.ts`
  already follows, for the same reason.
- **No query may be written without a `space_id` predicate.** Tenancy is
  enforced by the query, not by convention, and one missing predicate is a
  cross-tenant data leak. Access decisions live only in `authorize.ts` (M2).
- **`not_found`, not `forbidden`, for rows in a space the caller can't see** —
  `forbidden` confirms the id exists, turning the API into an existence oracle
  for other tenants' data.
- **Secrets go in `wrangler secret put`, never `[vars]`.** `wrangler.toml` is
  committed.
- **Timestamps and `sequence` are set server-side.** They exist for
  CalDAV/CardDAV compatibility, and clock skew between a user's devices would
  corrupt them.
- **Dev-only routes are registered conditionally, not guarded at runtime.** An
  `if` that's one edited line away from shipping a data-wiping seed endpoint to
  production isn't a guard.
