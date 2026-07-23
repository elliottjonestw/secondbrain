# Cloud Migration Plan — SQLite → Cloudflare

Moving Sekunda from a single-user local SQLite file to a multi-user Cloudflare
backend, so data follows the user across devices.

## 1. Decisions (locked)

| Question | Decision |
| --- | --- |
| Offline | Remote-authoritative. Reads served from a local cache when offline; **writes require connectivity and fail loudly.** |
| Tenancy | Multi-user now, resource sharing between accounts later. |
| Platforms | Desktop today. Web + mobile are the end goal — don't fix existing gaps, but introduce no new ones. |
| Auth | Own implementation on Workers. No third-party identity provider. |
| API shape | Typed REST endpoints. The Worker owns all SQL. |
| Read cache | IndexedDB response cache (no local SQL engine). |
| Existing data | Disposable. No import tooling. |
| Secrets | OpenAI key + CalDAV credentials stay client-side in `localStorage` for now. |
| Scope | Vertical slice first: full stack, one domain (todos + lists) end to end. |

### The assistant (`ai.ts`) — my call

**Route its tools through the same typed endpoints**, and move `queryTerms`,
`anyTermClause` and `matchQuery` out of `db.ts` into a shared package that the
Worker imports.

The reasoning: `CLAUDE.md` already records that these three helpers live together
specifically because two copies would drift on the exact phrasing bug they exist
to prevent (`%lunch with Alex meeting%` matching nothing). Splitting ranking
between a client copy and a server copy recreates that hazard at a worse scale.
One implementation, executed server-side, imported by both.

A second "looser query endpoint for the assistant only" is unnecessary once you
notice that **`ai.ts`'s tool schemas are the most demanding consumer of the API**.
If each search endpoint accepts what `search_todos` / `search_events` /
`search_notes` already accept — query terms, date window, `limit`/`offset`,
completion state, list, tag — and returns `{ items, total, truncated,
partial_match }`, which is already the assistant's result contract, then the UI's
needs are a strict subset. Design the search endpoints from the tool schemas and
both consumers are served by one locked-down path.

---

## 2. Target architecture

```
┌─ Client (Tauri webview / browser tab / mobile webview) ───────┐
│  views/  ai.ts  calendars.ts        ← unchanged signatures    │
│  db.ts          ← becomes a typed API client, same exports    │
│  lib/api.ts     ← fetch wrapper, auth headers, retries        │
│  lib/cache.ts   ← IndexedDB response cache (SWR)              │
│  lib/caldav/    ← unchanged; still talks to iCloud directly   │
└───────────────────────────┬───────────────────────────────────┘
                            │ HTTPS, Bearer token
┌───────────────────────────▼───────────────────────────────────┐
│  Cloudflare Worker (Hono)                                     │
│    /v1/auth/*      register · login · refresh · logout        │
│    /v1/{domain}/*  todos lists events reminders notes people  │
│                    tags links search images                   │
│    authorize()     ← single choke point for access control    │
│    packages/shared ← zod schemas + matchQuery ranking         │
└───────┬───────────────────────────────┬───────────────────────┘
        │                               │
   ┌────▼────┐                     ┌────▼────┐
   │   D1    │  all domain data    │   KV    │  note images
   │ SQLite  │  + users, sessions  │ blobs   │
   └─────────┘                     └─────────┘
```

Three properties worth naming:

- **Rust gets thinner, not thicker.** `lib.rs` drops `tauri-plugin-sql` and the
  migration registry entirely, leaving plugin wiring only. This satisfies
  architecture rule 1 more completely than today's code does.
- **iOS is unblocked as a side effect.** `tauri-plugin-sql` supports
  Windows/Linux/macOS/Android but **not iOS** — the current data layer was
  already a dead end for your mobile goal. Nothing in the new data path is
  Tauri-specific.
- **CalDAV is untouched.** It never stored anything in SQLite (a deliberate
  design noted in `CLAUDE.md`), so `calendars.ts` keeps its interface and merely
  finds that its "local" side is now a network call.

---

## 3. Repository layout

Convert to npm workspaces. The shared package is what stops client and server
types from drifting.

```
secondbrain/
  packages/
    shared/          # zod schemas, inferred TS types, matchQuery/queryTerms/
                     # anyTermClause, ItemType, row types. No runtime deps.
  worker/
    src/
      index.ts       # Hono app
      auth/          # register, login, sessions, password hashing
      routes/        # one file per domain
      db/            # D1 query helpers; the ONLY place SQL is written
      authorize.ts   # single access-control choke point
    migrations/      # wrangler d1 migrations
    wrangler.toml
  src/               # existing client
  src-tauri/
```

`packages/shared` must have **zero** Cloudflare or Tauri imports — it is compiled
into both sides.

---

## 4. Data model

### 4.1 Squash, don't replay

Existing data is disposable, so do **not** port `001`–`007` as seven D1
migrations. Author a single `0001_init.sql` that is the squashed schema plus
tenancy columns. Benefits: the `PRAGMA foreign_keys` trap from `001` disappears
(it only ever applied to the migration connection anyway), and there's no
seven-step history to debug on a platform you're new to.

D1 has its own migration system (`wrangler d1 migrations apply`) with its own
tracking table. The `src-tauri/migrations/` directory is deleted at the end of
M3, not before — the browser dev path still needs it until the cutover.

### 4.2 Tenancy: spaces, not user ids

Do **not** put `user_id` on domain rows. Put `space_id`.

```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  email_norm    TEXT NOT NULL UNIQUE,   -- lowercased + NFC, see 4.4
  kdf_salt      TEXT NOT NULL,          -- public by necessity, see 5.1
  kdf_params    TEXT NOT NULL,
  verifier_salt TEXT NOT NULL,
  verifier_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE spaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE space_members (
  space_id  TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  role      TEXT NOT NULL,        -- owner | editor | viewer
  PRIMARY KEY (space_id, user_id)
);
CREATE INDEX idx_space_members_user ON space_members(user_id);
```

Registration creates a user, a personal space, and an `owner` membership.

Why this rather than `owner_id`: you said sharing is coming. With `owner_id`,
sharing means a migration across all eleven domain tables *and* rewriting the
`WHERE` clause of every endpoint. With `space_id`, sharing a whole space is one
`space_members` insert, and resource-level sharing is one additive table:

```sql
-- Not built in this project. Designed for, so it stays additive.
CREATE TABLE shares (
  id             TEXT PRIMARY KEY,
  resource_type  TEXT NOT NULL,   -- 'list' | 'calendar' | 'note' | ...
  resource_id    TEXT NOT NULL,
  grantee_user_id TEXT NOT NULL,
  role           TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
```

Every domain table gains `space_id TEXT NOT NULL` plus an index on it, and every
index that begins with a lookup column gets `space_id` prefixed.

### 4.3 Uniqueness constraints must become per-space

This is the highest-risk detail in the whole schema conversion.

- `tags.name` is currently globally `UNIQUE` → must become
  `UNIQUE (space_id, name)`.
- `007`'s `idx_lists_name_nocase` on `lists(name COLLATE NOCASE)` → must become
  `UNIQUE (space_id, name COLLATE NOCASE)`.

Ported verbatim, one user creating the tag `work` permanently prevents every
other user from doing so, and the failure looks like an unrelated write error.
Audit every `UNIQUE` in `001`–`007` before writing `0001_init.sql`.

### 4.4 Identity keys and collation

`normalizeKey`'s NFC normalization matters *more* now, not less: macOS IMEs emit
NFD, D1 compares byte-wise exactly as local SQLite does, and a tag name arriving
from an iOS client vs a macOS client must collide correctly. Move `normalizeKey`
into `packages/shared` and apply it **server-side** on write — a client-side-only
normalization is unenforceable once there are several clients.

Same reasoning for email: store `email_norm` (lowercased + NFC-normalized) as the
unique key, and the display email separately.

`Intl.Collator` sorting stays client-side. D1 has no ICU either.

### 4.5 FTS5

D1 supports FTS5 including the **trigram** tokenizer, so `005` ports essentially
as-is and the CJK behaviour you documented is preserved — including the rule that
sub-3-character queries must route to `LIKE`, since trigram still can't answer
them. That routing logic moves into the Worker.

Two adjustments:

- Every FTS query must join back to `notes` and filter `notes.space_id = ?`.
  The FTS table itself carries no tenancy; forgetting the join leaks other
  users' note content through search. Make this impossible by putting the note
  search query in exactly one function.
- **`wrangler d1 export` cannot export a database containing virtual tables**
  (a known, open issue). Your backup strategy must therefore be a *logical*
  export — a Worker endpoint that walks the tables — not a platform-level dump.
  This also replaces `lib/backup.ts`'s `exportTables`/`importTables`.

### 4.6 Note images → Workers KV

`note_images` currently stores base64 in a `TEXT` column. D1 caps any row or BLOB
at **2 MB** and any database at **10 GB**, so this cannot survive as-is.

> **Revised after M4b.** This section originally specified R2, and M4b shipped
> against it. R2 is the better-shaped product for blobs — but Cloudflare
> requires a **payment method on the account to enable R2 at all, including its
> free tier**. Keeping no card on file is the only hard guarantee that a traffic
> spike, abusive or accidental, can never become a bill: free-plan products
> return quota errors rather than billing an overage. That guarantee was worth
> more here than R2's shape, so the bytes moved to **Workers KV**, which ships
> with the Workers free plan and needs no card. Migration `0003` renames
> `r2_key` to `blob_key`; everything else below is unchanged, because the split
> between "pointer in D1" and "bytes elsewhere" was never R2-specific.
>
> What the trade costs: **1 GB** of storage instead of 10 GB (a few thousand
> images at the ~300 KB `encodeNoteImage` produces), **1,000 writes/day** and
> **1,000 deletes/day** on separate counters, and a **25 MB** value cap that
> nothing here approaches. Reads are 100,000/day, so viewing is not the
> constrained direction. KV is also eventually consistent — a just-written key
> can read as missing for up to 60 s — which costs nothing here only because
> `primeNoteImage` already puts the uploaded bytes straight into the client
> cache, so the first render after an upload never reads back. **Do not add a
> read-back verification step to the upload path.**

- Image bytes go to KV under `spaces/<space_id>/notes/<note_id>/<image_id>`.
- D1 keeps only metadata: id, note_id, space_id, mime, `blob_key`, width,
  height, size, created_at.
- Note bodies keep the `![alt](sbimg:<id>)` token — **unchanged**, which means
  the `ReactMarkdown` `components={{ img: NoteImage }}` +
  `urlTransform={noteUrlTransform}` pairing and the assistant prompt's
  "preserve `sbimg:` refs verbatim" rule both still hold.
- `NoteImage` resolves the token to an authenticated `GET /v1/images/:id`, which
  the Worker reads from KV. Fetch as a blob and `URL.createObjectURL`, since
  an `<img src>` can't carry a Bearer header.
- Keep the placeholder-token-then-swap insert flow exactly as it is; the upload
  is now slower, which makes that async-safety measure more necessary, not less.

Neither KV nor R2 charges egress. KV wins here only because it needs no card
on the account; see the revision note above.

---

## 5. Authentication

### 5.1 Password hashing on the free tier: derive on the client, verify on the server

The Workers **free plan caps CPU at 10 ms per request**, and a correctly tuned
Argon2id costs 50–150 ms of CPU *by design* — that cost is the entire defence
against offline cracking. Fitting Argon2id into 10 ms would mean gutting the
work factor, and PBKDF2 tuned to 10 ms lands around a sixth of OWASP's
recommended iteration count with no headroom left for the rest of the request.
Neither is acceptable.

The resolution is not to do less work but to **do it somewhere that isn't
metered**:

```
client:  dk = argon2id(password, kdf_salt, kdf_params)        ~100 ms, user's device
wire:    dk                                                    over TLS
server:  verifier = sha256(verifier_salt || dk || PEPPER)      ~0.01 ms CPU
```

This is the standard password-manager architecture — Bitwarden, 1Password and
Firefox Sync all work this way — and its security properties are equal to or
better than server-side hashing:

- **Offline cracking resistance is unchanged.** An attacker holding the `users`
  table has `kdf_salt`, `kdf_params` and the verifier, and still has to run the
  full Argon2id for every guess. The expensive step is not skippable; it has
  only moved.
- **A database dump is not directly replayable.** `dk` is password-equivalent,
  so it must never be what's stored — hence the server-side `sha256`. Storing
  `dk` raw would be the one fatal mistake in this design.
- **The server never sees a plaintext password**, so one cannot leak through a
  log line, an error report or a stack trace. This is strictly better than the
  conventional model.
- **The pepper lives in Worker secrets, not the database**, so a D1 dump alone
  is insufficient to test guesses.

The genuine trade-offs, stated plainly:

- **The client controls the work factor.** A modified client could register with
  degenerate parameters. The server enforces a floor (OWASP's m=19 MiB, t=2,
  p=1) and rejects anything weaker, and a client that lies only ever weakens its
  own account — it cannot affect anyone else's.
- **Password length is validated client-side only.** Same containment argument.
- **The KDF parameters must be fetchable before login**, which makes
  `POST /v1/auth/kdf` an account-existence oracle unless handled. It never
  404s: unknown addresses get a decoy salt derived from
  `HMAC(AUTH_PEPPER, email_norm)`, deterministic so repeated probes for one
  address stay self-consistent. A random decoy would leak the answer to anyone
  who asked twice.
- **Login costs an extra round-trip** (fetch params, then submit). Registration
  does not — the client generates its own salt.
- **`m` is capped as well as floored.** It is allocated on whichever device is
  signing in, and an unbounded value is a way to make a phone fail to log in.

Implementation: `hash-wasm`'s Argon2id on the client. It inlines its wasm as
base64, so it sidesteps the Vite wasm-path trap that `@sqlite.org/sqlite-wasm`
needed `optimizeDeps.exclude` for.

### 5.2 Living inside the rest of the free tier

| Limit | Free | Where this project touches it |
| --- | --- | --- |
| Worker CPU | 10 ms/request | Solved above. Everything else — JWT HMAC, zod, JSON — is well under. |
| Worker requests | 100,000/day | Comfortable for a handful of users, but it makes the response cache load-bearing rather than a nicety. |
| D1 rows read | 5,000,000/day | **Counts rows _scanned_, not returned.** A query without an index burns quota proportional to table size. |
| D1 rows written | 100,000/day | Ample. |
| D1 storage | 5 GB | Ample; images go to KV. |

Two consequences worth designing for now rather than discovering later:

- **Every query must hit an index.** This is why `space_id` is the first column
  of every index in `0001_init.sql`. A full scan is no longer just slow, it is
  metered.
- **Prefer one bulk revalidation endpoint over per-domain polling.** With
  poll-on-focus across five Today widgets, a naive client can spend thousands of
  requests a day doing nothing. A `GET /v1/sync/changes?since=` that returns
  what moved is both cheaper and simpler than eight conditional GETs.

Neither of these is a compromise forced by the free tier — they're the right
design regardless. The free tier just makes the cost of getting them wrong
visible immediately instead of on a bill.

### 5.3 Where the paid plan would still buy something

Not needed to ship, but worth knowing the trigger conditions: sustained traffic
past 100k requests/day, a dataset large enough that read quota bites, or D1
read replication to cut latency for a user far from the primary region.

### 5.4 Tokens, not cookies

Cookies are the wrong choice here: the Tauri webview's origin is
`tauri://localhost`, `@tauri-apps/plugin-http` does not share the webview's
cookie jar, and mobile clients compound the problem.

- **Access token**: JWT, HMAC-signed with a secret in Worker secrets, ~15 min
  TTL, stateless, carries `user_id` and nothing sensitive.
- **Refresh token**: 32 random bytes, stored *hashed* in a `sessions` table with
  device label, `expires_at`, `revoked_at`. Rotates on every use; presenting an
  already-rotated token revokes the whole family (standard theft detection).
- Storage: OS keychain on desktop/mobile via a secure-storage plugin;
  `localStorage` on web, accepting the XSS trade-off that a web build implies.
  Isolate this behind `lib/authStore.ts` so each platform swaps one file.

### 5.5 Endpoints

```
POST /v1/auth/register   { email, password }        → tokens
POST /v1/auth/login      { email, password }        → tokens
POST /v1/auth/refresh    { refresh_token }          → tokens (rotated)
POST /v1/auth/logout     revokes the session
GET  /v1/auth/me         → user + spaces + roles
```

Constant-time comparison, identical error text and timing for "no such user" and
"wrong password", and Cloudflare Rate Limiting on `/auth/*` keyed by IP and by
email.

### 5.6 Recovery (shipped in M5)

> Originally deferred as out of scope for the vertical slice. Delivered in M5,
> on Resend (MailChannels is no longer free for Workers; Resend's free tier is
> ~100/day and needs no card, which keeps §11's card-free guarantee).

The shape that matters: **a reset token does not authorise a password change.**
It authorises replacing the account's `kdf_salt`, `kdf_params` and
`verifier_hash` with values the *client* derived from the new password. The
server therefore still never sees a plaintext password — at the one moment the
design would be easiest to abandon.

- Tokens are 32 random bytes, stored as `sha256(token)` (a D1 dump must not
  contain working reset links), single-use via a conditional `UPDATE … WHERE
  used_at IS NULL … RETURNING` so a race cannot redeem one twice, and expire in
  30 minutes.
- **Using one revokes every session.** A reset is what someone does when they
  believe their password is known; leaving the attacker's refresh token alive
  would make it cosmetic.
- **The request endpoint is not an existence oracle**, mirroring `/auth/kdf`:
  one response for known addresses, unknown addresses, a provider outage and an
  unconfigured `RESEND_API_KEY` alike. The failure modes had to be flattened
  too — a distinct "email isn't set up" for real accounts would leak just as
  loudly as a 404.
- Requests are limited per address *and* per IP: the address key stops one
  mailbox being flooded, the IP key stops a client walking a list.
- The token rides in the URL **fragment**, never the query string, so it is
  never sent to a server and never appears in a `Referer`.

**The one bound worth naming:** access tokens are stateless 15-minute JWTs
verified without a database read (§5.4), so a reset does not invalidate one
already in flight. An attacker holding one keeps access for its remaining life
and cannot extend it. Closing that window means a session lookup per request or
a revocation list in KV — not judged worth it, but a known bound rather than an
oversight.

Email confirmation ships alongside. It was **initially** not a login
precondition — it arrived after accounts existed, so enforcing it would have
locked out every earlier user. Once every live account was confirmed, that
constraint lifted and confirmation became **required to sign in** (a later,
deliberate change):

- Registration no longer issues tokens. It creates the account, mails a link,
  and returns `{ verification_required: true }`; the client shows "check your
  inbox" and routes to sign-in. Auto-login here would be a hole straight
  through the gate.
- Login checks `email_verified_at` only *after* the password verifies, and
  refuses an unconfirmed account with a distinct `email_unverified` code. That
  path is reachable only by someone who already knows the password, so it
  reveals confirmation state to nobody else — it is not an enumeration oracle.
- The resend endpoint had to become **public** (`/auth/email/verify/resend`),
  because a user who can't sign in can't reach an authenticated one. It is
  oracle-safe and rate-limited exactly like `/auth/password/forgot`.

The coupling this introduces, worth stating: **the gate and the mailer are now
one system.** With no `RESEND_API_KEY` set, confirmation mail never sends and
no new account can ever sign in. On an environment with real users that is a
hard dependency, not a degraded-but-working state.

### 5.7 Client-side gate

`App.tsx` gains an auth gate: no valid session → `LoginView` / `RegisterView`,
and nothing else mounts. Note this interacts with an existing constraint —
`useAssistantChat` is called once in `App.tsx` and must stay above any surface
that unmounts. Mount the gate *above* it so a logout tears down the hook
cleanly rather than leaving a turn running against a revoked token.

---

## 6. API design

### 6.1 Contract

Hono for routing (Workers-native, tiny). Every request and response body is a
**zod schema in `packages/shared`**, with TS types inferred from it. The Worker
validates at the boundary; the client imports the same types. This is what makes
"the client can't drift from the server" structurally true rather than a
convention.

### 6.2 Signature preservation

`db.ts` keeps its exported function names and signatures wherever possible —
`listTodos`, `upsertTodo`, `toggleTodo`, `searchNotes`, `tagsForItem`, and the
rest. Views, `calendars.ts` and `ai.ts` then need few or no changes. About 60
exports map to roughly 45 endpoints once CRUD is grouped.

### 6.3 Three signatures that must change

These are the real behavioural changes, and they're worth calling out because
they're where a naive port would quietly become slow:

1. **`listEvents()`, `listTodos()`, `listNotes()` currently return entire
   tables.** Fine against a local file; a full table transfer per call over a
   network. All three gain mandatory windowing — `listEvents({ from, to })`,
   cursor pagination on the others.

2. **`listNotes()` is called on every search keystroke** (documented in
   `CLAUDE.md`, and the reason note images were split out of `notes.body`).
   That becomes a network round-trip per character. Note search must move
   server-side, behind the existing debounce, with in-flight cancellation.
   The same "snap the window to whole days, debounce it" discipline you already
   apply to `getRemoteOccurrences` now applies to every search box.

3. **`searchEvents`'s asymmetry gets a third case.** It currently merges an
   all-time local SQLite search with a windowed CalDAV fetch, and
   `SearchView`'s footer must state the window. Local is now also a network
   call, but still all-time — so the footer's contract is unchanged. Verify this
   rather than assuming it; it's the kind of invariant that breaks silently.

### 6.4 Writes

- **Client-generated UUIDs stay.** `newId()` remains client-side, and every
  write is idempotent on that id. On a flaky mobile network, a retried
  `upsertTodo` must not create a duplicate — this one decision is what makes
  retries safe.
- Partial-merge semantics are preserved: the assistant's write tools distinguish
  clear-to-null from leave-alone via `"field" in args`. Over JSON that means
  **`PATCH` with explicit `null` meaning clear, and an absent key meaning leave
  alone** — so the Worker must inspect key presence, not just value nullishness.
  `undefined` does not survive `JSON.stringify`; this is a live bug waiting if
  it's handled carelessly.
- `sequence` / `created_at` / `updated_at` are set **server-side**. They exist
  for CalDAV/CardDAV compatibility and clock skew between devices would corrupt
  them.
- `reorderTodos(ids)` and `reorderCustomFields(ids)` send the whole ordered
  array in one request — never one request per item.
- Cascading deletes stay explicit in the Worker (`deleteTodo` → subtasks,
  `deleteNote` → images + KV values), for the same reason as before: don't rely
  on FK cascade.

### 6.5 Authorization

One function, called by every route, no exceptions:

```ts
authorize(ctx, { resourceType, resourceId?, spaceId?, action })
```

Resolves the caller's spaces once per request, checks membership and role, and
throws a typed 403. Every SQL statement in `worker/src/db/` takes `space_id` as
a bound parameter. The rule to enforce in review: **no query may be written
without a `space_id` predicate**, and access decisions live nowhere but
`authorize.ts`. Scattered checks across 45 routes is how tenancy leaks happen.

---

## 7. Client: cache and offline

### 7.1 Cache

`src/lib/cache.ts`, IndexedDB via the `idb` package.

- Key: endpoint + stably-stringified params. Value:
  `{ data, fetchedAt, etag }`.
- Reads are **stale-while-revalidate**: serve cache immediately, revalidate in
  the background, update on change. This preserves the behaviour `useAsync`
  already depends on — keeping the previous value during a reload instead of
  flashing a skeleton on every checkbox tick.
- The Worker sets `ETag`; the client sends `If-None-Match`. A `304` is nearly
  free and is what makes background revalidation cheap enough to do often.
- Writes invalidate by **tag** (`todos`, `notes`, `tags`), not by exact key,
  then refetch. Invalidation across related domains — deleting a note must
  invalidate `links` and `item_tags` too — is declared in one map, not
  scattered.

### 7.2 Offline

- A single `useOnline()` source of truth, driven by `navigator.onLine` plus
  actual request outcomes (`navigator.onLine` lies about captive portals).
- Reads offline: served from cache, flagged stale, with a persistent banner.
- Writes offline: `lib/api.ts` throws a typed `OfflineError` **before** issuing
  the request. Every mutation call site renders it as an explicit "can't save —
  you're offline" state. No optimistic UI, no silent queue: you chose
  read-only-offline, and the failure mode that destroys trust is a write that
  looked like it worked.
- The note editor's 400 ms debounce with flush-on-unmount now guards a *network*
  write. Keep the debounce; add a visible saved/saving/failed indicator, because
  a failed background save is otherwise invisible.

### 7.3 Freshness across devices

Poll-on-focus plus revalidate-on-navigate for v1 — cheap, and adequate for one
person moving between their own devices. If real-time becomes necessary, the
place for it is a Durable Object per space holding a WebSocket fan-out. Don't
build it now.

### 7.4 Platform-safety checklist

To honour "introduce no new web/mobile problems":

- All data access is plain HTTPS + IndexedDB — available on every target.
- No new Tauri-only API in the data path; the only platform-conditional module
  is `authStore.ts` (keychain vs `localStorage`).
- `@tauri-apps/plugin-http`'s `fetch` is still required inside Tauri (the
  webview's own `fetch` hits CORS from `tauri://`), and the Worker's origin must
  be added to `capabilities/default.json`'s http scope. `lib/api.ts` picks the
  right `fetch` at runtime, so web and mobile builds use the native one.
- The Worker must send permissive CORS for the eventual web origin **and** for
  `tauri://localhost`.

---

## 8. Development and testing

The browser dev story changes and, done right, gets better.

Today, `npm run dev` falls back to `lib/browserDb.ts` — sqlite-wasm running the
real `src-tauri/migrations/*.sql`, seeded from `lib/demo.ts`. That's why schema
can't drift. It's also why `CLAUDE.md` warns it "proves SQL and UI, never runtime
behaviour."

Replacement: **`wrangler dev` with a local D1**, running the real migrations
against a real (Miniflare) SQLite. The client points at `localhost:8787`.

- Schema still can't drift — it's the same migration files the deployed Worker
  uses.
- It now proves *more* than before: the actual bridge (HTTP + JSON) is the same
  one production uses, closing the gap the old browser path explicitly couldn't.
- `lib/demo.ts` becomes `POST /v1/dev/seed`, registered only when
  `env.ENVIRONMENT === "development"`. Guard it at route-registration time, not
  with a runtime `if` — an unguarded seed endpoint in production wipes real data.
- `lib/browserDb.ts` and the `@sqlite.org/sqlite-wasm` dependency are deleted,
  along with the `optimizeDeps.exclude` workaround that existed to serve it.
- E2E: `wdio.conf.ts` still targets the binary inside the bundle. Specs now need
  a test account and a seeded space; add a fixture that registers a throwaway
  user against a local Worker. `e2e/noteImages.spec.ts` needs rewriting for the
  images API.

Verification per change stays `npx tsc --noEmit` + `npx vite build`
(+ `cd src-tauri && cargo check`), with `tsc` now also run in `worker/` and
`packages/shared/`.

---

## 9. Milestones

**M0 — Infrastructure.** Workspaces conversion, `packages/shared` skeleton,
Worker + Hono + `wrangler.toml`, D1 database created, `0001_init.sql` written
(squashed schema + `space_id` + per-space unique indexes), `wrangler dev`
running locally, deploy pipeline to a staging Worker.

**M1 — Auth.** `users`/`spaces`/`space_members`/`sessions` tables, Argon2id
hashing, the five auth endpoints, rate limiting, `authorize.ts`, `lib/api.ts`,
`lib/authStore.ts`, `LoginView`/`RegisterView`, the `App.tsx` gate. Deliverable:
you can register on one machine and log in on another. No app data yet.

**M2 — Vertical slice: todos + lists.** Full path — endpoints, `authorize`
integration, `db.ts` rewritten for those functions only, `lib/cache.ts`,
offline read + loud write failure, `TodosView` working end to end, `ai.ts`'s
todo tools routed through the API, ranking helpers moved to `packages/shared`.
**Stop here and review the endpoint pattern before continuing** — this is the
whole reason for slicing, and every mistake found here is a mistake not copied
forty more times.

**M3 — Remaining domains.** Events, reminders, notes (incl. FTS + the `LIKE`
routing for short CJK queries), people + custom fields, tags, links. Then
`calendars.ts` re-pointed, `SearchView`, the Today widgets, the rest of `ai.ts`.
Delete `tauri-plugin-sql`, `src-tauri/migrations/`, `browserDb.ts`. Mostly
mechanical if M2's pattern is right.

**M4 — Images out of D1.** KV namespace, upload/read endpoints, `NoteImage`
blob resolution, delete-cascades-to-KV, E2E spec rewrite.

**M5 — Hardening.** *Delivered.* Email confirmation and password reset over
Resend (§5.6); the logical export/backup endpoint replacing `lib/backup.ts`;
account deletion, gated on re-deriving the key from a freshly typed password
and removing the user, their sole-member spaces, every domain row and the KV
image bytes; per-user rate limits on the two proxy routes (`/v1/dav`,
`/v1/quotes/*`) via Cloudflare's in-colo limiter rather than a D1 counter; a
build-time CSP on the web bundle plus `nosniff`/`X-Frame-Options`/
`Referrer-Policy` on every API response; and the Tauri HTTP scope narrowed off
`http://*`.

Two items were closed with a decision rather than code, which is the honest
outcome for both:

- **D1 read replication: not enabled.** It doesn't address the measured cost —
  the ~105 ms in §10 is a round-trip to a primary already in the caller's
  region — and switching it on without adopting the Sessions API means a client
  can read back a list missing the todo it just wrote. This app writes and
  re-reads on every checkbox tick, so that is the main flow, not an edge case.
  Revisit with users far from the primary, and adopt the Sessions API in the
  same change.
- **Error monitoring: Workers logs (`[observability]`), not a service.** Every
  hosted alternative is another account and usually a card, and the failure it
  catches — a 500 a user reports by its `X-Request-Id` — is found just as fast
  with `wrangler tail`. What makes it sufficient is that the error handler logs
  method and *routed path* alongside the id, so a line is actionable on its own;
  it never logs a URL or a body.

The load sanity-check is `worker/scripts/loadcheck.mjs`. It deliberately
measures shape rather than throughput: each endpoint's latency should be
proportional to the number of D1 queries it makes, and anything much worse is
an N+1 or a missing index — the failure that quietly burns the rows-scanned
quota.

**Update `README.md` in the same session as each milestone** — this changes
features, architecture, the data model, permissions and the AI toolset, which
is every category the golden rule names.

---

## 10. Risks and traps

| Risk | Mitigation |
| --- | --- |
| **Workers free plan's 10 ms CPU cap** rules out server-side Argon2id | Client-side KDF + server-side verifier (§5.1). Never store the derived key raw — it is password-equivalent. |
| **The KDF-params endpoint is an account-existence oracle** if it 404s on unknown addresses | Always answer; decoy salt from `HMAC(AUTH_PEPPER, email_norm)`, deterministic so repeat probes agree. |
| **`AUTH_PEPPER` rotation locks out every account** (unlike `JWT_SECRET`, which merely signs everyone out) | Set once, never rotate. Documented in `env.ts` where it would be changed. |
| **D1 counts rows _scanned_**, so an unindexed query burns daily quota proportional to table size | `space_id` leads every index; no query ships without one. |
| **100k requests/day** is spendable on idle polling alone | Response cache is load-bearing; one bulk `?since=` revalidation endpoint, not per-domain polls. |
| **Global `UNIQUE` on `tags.name` / `lists.name`** leaks across tenants and fails obscurely | Audit every `UNIQUE` in `001`–`007`; make them `(space_id, …)`. |
| **A query written without a `space_id` predicate** silently exposes another user's data | All SQL confined to `worker/src/db/`; all access decisions in `authorize.ts`; review rule enforced. |
| **Every D1 query costs a full round-trip to the primary.** Measured on staging (APAC primary, same-region caller): **~105 ms for a trivial `COUNT` on an empty table**, warm, consistent across samples. This is a floor, not a load effect. | Treat query *count* as the latency budget, not row count: three sequential queries is ~315 ms. Batch with `D1.batch()`, never N+1, and let the response cache absorb repeat reads. Read replication (currently `disabled`) is a later lever and won't help a caller already beside the primary. |
| **D1 caps rows at 2 MB, databases at 10 GB** | Images to KV in M4; nothing else in the schema approaches either limit. |
| **`d1 export` can't dump a database with virtual tables** (FTS5) | Backups are a logical export endpoint, not a platform dump. Verify restore before you rely on it. |
| **`undefined` doesn't survive JSON**, breaking partial-merge semantics | `PATCH` contract: absent key = leave alone, explicit `null` = clear. Worker inspects key presence. |
| **Full-table `list*()` calls become full-table transfers** | Mandatory windowing/pagination in the endpoint signatures from day one. |
| **Search-per-keystroke becomes a request per character** | Server-side search behind the existing debounce, with in-flight cancellation. |
| **A failed background save is invisible** in the debounced note editor | Explicit saving/saved/failed indicator. |
| Retried writes on flaky mobile networks duplicate rows | Client-generated UUIDs + idempotent upserts, preserved from the current design. |
| Dev seed endpoint reachable in production | Registered conditionally at startup, not guarded at runtime. |
| **Enabling R2 requires a payment method**, and a card on file means an abusive spike can bill rather than just fail | Note images live in Workers KV, which the Workers free plan includes with no card (§4.6). Keep the account card-free; every quota then fails closed. |
| **KV is eventually consistent** — a key can read as missing for ~60 s after it is written | Nothing reads back a key it just wrote: `primeNoteImage` caches the uploaded bytes client-side, so the first render never fetches. Never add read-back verification to the upload path. |
| **KV deletes one key per call**, unlike R2's bulk delete, and deletes have their own 1,000/day counter | `deleteNoteImageBlobs` issues them concurrently; a note with many images costs one call each. |

## 11. Known gaps this plan accepts

- **The OpenAI key and CalDAV credentials don't follow the user** (your call to
  keep them client-side). Each new device needs them re-entered — a little at
  odds with the point of the migration. Revisit once accounts exist.
- **No offline note search.** The response cache can't answer FTS queries; a
  crude scan over cached notes is the fallback if it's missed.
- **No offline writes**, by design.
- **Password reset needs `RESEND_API_KEY` set on the environment.** Until it
  is, the flow exists but silently sends nothing — visibly to the operator in
  `wrangler tail`, invisibly to the user, because the response cannot vary
  without becoming an existence oracle (§5.6).
- **A reset doesn't invalidate an access token already in flight** — a bounded
  15-minute window, explained in §5.6.
- **Proxy rate limits are per-colo, not global**, being Cloudflare's in-colo
  limiter. Sound against one stolen session relaying from one place; a
  genuinely distributed caller gets the budget several times over, and hits the
  Worker's own 100k/day first.
- **No real-time sync.** Poll-on-focus only.
- **Note images are capped at 1 GB in total, and 1,000 uploads per day**, being
  the Workers KV free-tier limits (§4.6). At the ~300 KB `encodeNoteImage`
  produces that's a few thousand images across all users. Outgrowing it means
  either paying for R2 or sharding across namespaces — a deliberate future
  decision, not a surprise.
- **No card on the Cloudflare account, deliberately.** Every product in use
  (Workers, D1, KV) is on a free plan that fails closed with quota errors rather
  than billing an overage, so the worst an abusive spike can do is take the app
  offline until the counter resets at 00:00 UTC. Adding a payment method to
  enable any paid product forfeits that property account-wide — treat it as a
  decision, not a config change.
