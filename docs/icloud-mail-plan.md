# iCloud Mail (read-only) — implementation plan

## Goal & scope

Let users connect their iCloud Mail inbox (IMAP, app-specific password) and let the AI assistant read it. **Read-only. No sending. iCloud only.** Mirrors the existing iCloud CalDAV integration's architecture, security posture, and code conventions as closely as possible.

The one architectural divergence from CalDAV: IMAP is a **stateful TCP socket protocol**, while the CalDAV direct path rides on `tauri-plugin-http` (HTTP only). So:

- **Desktop (Tauri):** talks to `imap.mail.me.com:993` directly via a **new Rust command** backed by an async IMAP crate. Worker never sees mail. This is the first custom networking in the Rust layer.
- **Web:** relays through a **new Worker route** that speaks IMAP over `cloudflare:sockets` (`connect()`, GA, reaches 993). Same privacy contract as `worker/src/routes/dav.ts` — TLS terminates at the Worker, nothing stored, nothing logged.

Everything else mirrors CalDAV: credential in `secrets.ts`, account config in a new `secondbrain.mail` bucket, assistant tools gated behind a connected inbox.

---

## Files changed / created

### A. Credential storage — `src/lib/secrets.ts` (edit)
Add a third secret alongside `openai` and `caldav`, mirroring the CalDAV accessor exactly (lines 115–128).
- New key: `const MAIL_KEY = "secondbrain.secret.mail";`
- `getMailPassword()` / `setMailPassword(value)` — same `read`/`write` + `scopedKey` shape.
- Extend `clearSecrets()` (lines 154–160) to wipe it on sign-out / account delete — load-bearing, else a returning user leaves a credential behind.

Note for the user that already has a CalDAV app-specific password: one Apple app-specific password covers *both* Mail and Calendar, so we should detect an existing CalDAV password and offer to reuse it rather than making them paste it twice. (Polish, not blocking.)

### B. Account config — `src/lib/settings.ts` (edit)
Add a new per-domain bucket mirroring `CalendarSettings` (lines 572–648), **not** a field on `AppSettings` and **never** in `CLOUD_SETTING_KEYS` (credentials don't sync).
```ts
export interface MailFolder { name: string; delimiter: string; flags: string[]; } // IMAP LIST response
export interface MailAccount {
  provider: "icloud";            // future: "yahoo" | "fastmail" | "generic"
  username: string;              // Apple ID
  host: string;                  // "imap.mail.me.com"
  port: number;                  // 993
  folders: MailFolder[];         // discovered via LIST, cached
  connectedAt?: string;
}
export interface MailSettings { account: MailAccount | null; }
const MAIL_KEY = "secondbrain.mail";
export function getMailSettings(): MailSettings { ... }       // mirrors getCalendarSettings
export function saveMailSettings(patch): MailSettings { ... } // mirrors saveCalendarSettings
export function hasMailAccount(): boolean { ... }
```

### C. Mail module — `src/lib/mail/` (new directory)
Mirror the `src/lib/caldav/` split. Four files:

1. **`types.ts`** — shared types: `MailMessageSummary` (uid, subject, from, date, seen, snippet), `MailMessageDetail` (+ full body text, attachments list), `MailFolder`, `MailSearchParams`.
2. **`client.ts`** — the transport decision, mirroring `caldav/client.ts:davFetch` (lines 91–117):
   ```ts
   // The op envelope sent to EITHER the Rust command OR the Worker relay.
   interface ImapOp { host; port; user; pass; mailbox?; op: "list" | "search" | "fetch"; ... }
   async function imapCall(op): Promise<unknown> {
     if (isTauri()) return invoke("imap_op", { op });      // desktop: direct
     return apiRequest("/v1/mail", { method: "POST", body: op }); // web: relay
   }
   ```
   The credential read happens in **one place** here — `getMailPassword()` from `secrets.ts` — never in callers. (Mirror of `basicAuth()` at caldav/client.ts:58.)
3. **`mailbox.ts`** — business logic: `listFolders()`, `searchMail(account, { since?, from?, subject?, limit })`, `getMessage(account, uid)`. Build the op envelope, call `imapCall`, parse results. Fail-soft like calendars (return errors, don't throw, so a dead inbox never breaks the assistant loop).
4. **`index.ts`** — re-export surface, like `src/db/index.ts`.

**IMAP envelope design (stateless, one-op-per-call):** each `imapCall` does login → SELECT → one command → LOGOUT/close. Keeps the Worker stateless (matches the no-Durable-Objects stance in `worker/src/env.ts`) and the Rust command trivial. Slightly slower (re-handshake per query) — acceptable for read.

### D. Desktop direct path — `src-tauri/` (edit + new)
The new socket primitive. **First custom `#[tauri::command]` in the codebase.**

- **`Cargo.toml`**: add `async-imap = "0.x"` (pure-async, tokio-friendly), `tokio = { version = "1", features = ["full"] }`, and `futures`. Note: `async-imap` speaks the protocol; TLS via `async-native-tls` or `tokio-rustls`. (Confirm exact versions at implementation time.)
- **`src/mail.rs`** (new): an `async fn imap_op(op, state) -> Result<serde_json::Value, String>` `#[tauri::command]`. Host-allowlist check (only `imap.mail.me.com`, mirroring `dav.ts:isAllowedHost` — this is the SSRF guard for the desktop side). Opens TLS socket to 993, LOGIN, dispatches on `op`, LOGOUT, returns JSON.
- **`src/lib.rs`** (edit, currently lines 12–17): register the command — add `.invoke_handler(tauri::generate_handler![mail::imap_op])` to the builder. Add `mod mail;`.
- **No capability/CSP change needed.** Tauri custom commands aren't bound by the `http:default` allowlist (that scopes `tauri-plugin-http` only), and `tauri.conf.json` CSP is `null`. Worth verifying the socket isn't sandboxed under macOS hardened runtime at build time — flag for testing.

### E. Worker relay — `worker/src/routes/mail.ts` (new)
Copy `worker/src/routes/dav.ts` as the skeleton, but it's an **IMAP client, not a pass-through** (IMAP isn't HTTP, so it can't forward a raw request):
- `requireAuth()` + new `MAIL_LIMIT` rate limit (per-user, keyed by `c.get("userId")`).
- Host allowlist: only `imap.mail.me.com` (and its port 993). Copy the SSRF-prevention framing from `dav.ts` verbatim.
- Uses `connect()` from `cloudflare:sockets` to open a TLS socket, runs the same op envelope as the Rust command (login → op → logout), returns JSON.
- **Privacy contract copied from `dav.ts` verbatim**: no D1 write, no KV write, no logging of URL/headers/bodies (the `[observability]` log only captures metadata; never `console.log` a request or response). Same header comment structure, adapted to note email bodies are *more* sensitive than calendar events.
- A small pure-TS IMAP client (~few hundred lines) OR a worker-compatible library. **`imapflow` is Node-only and unlikely to work in a V8 isolate** — plan to hand-roll the minimal subset (CAPABILITY, LOGIN, SELECT, LIST, UID SEARCH, UID FETCH with BODY[] / BODYSTRUCTURE). RFC 3501 + 9051.

**Wire the route** in `worker/src/index.ts` (line 40, after `dav`): `app.route("/v1", mail);`

### F. Rate limit binding — `worker/wrangler.toml` (edit)
Add `MAIL_LIMIT` (`namespace_id = "1011"`, e.g. `limit = 60, period = 60` — mail is one round-trip per op, so comparable to DAV). **Must be repeated in all three env blocks** (top-level, `[env.staging]`, `[env.production]`) — wrangler does not inherit bindings, and a missing one is a hard failure at request time (per the existing comment at line 73–75).

### G. Assistant tools — `src/lib/ai.ts` (edit)
Two read tools, gated behind `hasMailAccount()` (mirror the `webSearch` conditional-inclusion pattern at lines 2308–2309):

- **`MAIL_TOOLS`** const array (mirroring `WEB_SEARCH_TOOL` at 845–873), containing:
  - `list_mailboxes` → returns `MailFolder[]`.
  - `search_mail` → `{ query?, from?, since?, mailbox?, limit }` → `{ total, truncated, results: MailMessageSummary[] }`.
  - `get_message` → `{ uid, mailbox? }` → full body + attachments.
- **Executors** `toolListMailboxes`, `toolSearchMail`, `toolGetMessage` — return JSON-serializable objects via the `src/lib/mail` module. Use `clampLimit` (line 100) + `DEFAULT_LIMIT`/`MAX_LIMIT` (75–76).
- **`executeTool` dispatch** (line ~1907): three new cases.
- **`statusFor`** (line ~1948): `"Searching your inbox…"` / `"Searching for “{{query}}”…"`.
- **`SYSTEM_PROMPT`** (after the Calendars/Weather section, ~line 2004): a new `Mail:` paragraph describing the tools and that they read the user's connected iCloud inbox.
- **Tool inclusion** at line 2309: `const turnTools = [...(hasMailAccount() ? MAIL_TOOLS : []), ...(webSearch ? WEB_SEARCH_TOOL : []), ...TOOLS];`

### H. Settings UI — `src/views/SettingsView.tsx` (edit)
Mirror `CalendarSettingsPane` (lines 1210–1417) as `MailSettingsPane`:
- New `"mail"` in the `Section` union (line 52) + `SECTIONS` array (line 54) + conditional render (line 148). Icon: `Mail`/`Inbox` (already imported per the explore report).
- `connect()`: `setMailPassword()` first (so the Rust/Worker LIST can read it), call `listFolders()`, save `MailAccount`. Restore-on-failure like the calendar `connect()` (lines 1238–1261).
- `disconnect()`: confirm dialog, clear settings + password (lines 1263–1272).
- Form: Apple ID input + `SecretInput` for app-specific password + hint linking to `APPLE_PASSWORD_URL` (line 49).
- `needsPassword` handling (line 1230) — same "sign-out cleared it" state.
- `MailSettingsPane` calls `getMailSettings()`/`saveMailSettings()` directly, NOT via `draft`/`patch`/`save` (matches calendar pane's independence from the AppSettings draft).

### I. i18n — `src/locales/en/app.json` + `zh-TW/app.json` (edit)
Mirror the `settings.calendars` block (lines 259–284) as `settings.mail`: `description`, `account`, `connected`, `appleId`, `appPassword`, `passwordHint`, `connect`, `reconnect`, `disconnect`, `confirmDisconnect`, `found_one`/`found_other` (mailbox count), `passwordScopeHint`, `passwordCleared`. Add `status.searchMail`, `status.searchMailFor`, `status.getMessage`. Add `settings.sections.mail`.

### J. Capabilities note — `src-tauri/capabilities/default.json`
**No change needed** for the Rust command path (custom commands aren't scoped by `http:default`). The existing `https://*.icloud.com/*` entry (line 29) is irrelevant to the socket path but harmless. Document this in the PR description so reviewers don't expect a scope edit.

---

## Implementation order (testable milestones)

1. **`secrets.ts` + `settings.ts`** — credential + account buckets. No behavior yet, compiles.
2. **`worker/src/routes/mail.ts` + wrangler `MAIL_LIMIT` + route mount** — web relay against iCloud. Test end-to-end from a `curl`/test script: LIST, SEARCH, FETCH. This validates the IMAP client logic and the sockets path in isolation.
3. **`src/lib/mail/`** + wire web path to it — web can connect an inbox and run ops through the relay, verified via a temporary debug button or the Settings pane.
4. **`src-tauri/src/mail.rs` + Cargo + lib.rs registration** — desktop direct path. Same op envelope, validated against the same iCloud account.
5. **`MailSettingsPane`** in SettingsView — full connect/disconnect UX on both platforms.
6. **Assistant tools** in `ai.ts` — `search_mail` etc., gated on `hasMailAccount()`.
7. **i18n** strings (en + zh-TW).

Each step leaves the app in a working state; step 2 is the riskiest (raw IMAP over sockets) and is deliberately isolated before any UI depends on it.

---

## Key risks & how the plan handles them

- **Worker IMAP client is the hard part.** Hand-rolling a minimal IMAP client in TS for the V8 isolate (`imapflow` won't run there). Mitigated by doing it first (step 2) against a real inbox with a test harness, before UI locks in a shape it can't deliver. Scope strictly to the needed commands (CAPABILITY/LOGIN/SELECT/LIST/UID SEARCH/UID FETCH/LOGOUT).
- **First Rust networking in the codebase.** `async-imap` + TLS + tokio is new ground. Mitigated by keeping `mail.rs` a single self-contained command with a host allowlist, mirroring the SSRF guard the Worker already enforces.
- **Privacy regression on web (vs the "everything client-side" goal).** Inherent to IMAP — the browser can't open sockets. Same trade the user already accepted for iCloud calendars (`dav.ts`), with email bodies being more sensitive. Surfaced explicitly; the plan copies `dav.ts`'s "nothing stored, nothing logged" discipline verbatim. Desktop gets the clean fully-client-side path.
- **One Apple app-specific password covers Calendar + Mail.** UX wrinkle: don't make users paste twice. Detect existing CalDAV password and offer reuse (polish step, noted in section A).
- **Worker free-plan CPU limits (~10ms historically, now higher).** IMAP login + fetch over a socket may approach limits on large mailboxes. Mitigated by strict per-op limits (`clampLimit`, cap FETCH body sizes) and the per-user rate limit. Flag if real-world testing shows timeouts — the fallback is pagination (UID SEARCH then UID FETCH in small batches).

---

## Out of scope (explicitly deferred)
- Any provider other than iCloud (Yahoo/Fastmail/Zoho/Graph/Gmail). The host allowlist and op envelope are designed so adding one is a preset, but no code is written for them here.
- Sending mail / SMTP. (Later phase; would reuse the relay + add `onConfirmDelete`-style gating for destructive writes.)
- Storing mail locally / a dedicated Mail view. Assistant reads are live; messages render inline in the chat, not as `ItemRef` cards (avoiding a heavy `ItemType` change touching `ITEM_TYPES` + Worker tags/links).
- Full-text body search (server-side IMAP SEARCH is header/subject focused). `search_mail` does IMAP SEARCH; deeper search is a later enhancement.
