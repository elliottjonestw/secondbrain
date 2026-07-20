# CLAUDE.md — Second Brain

Guidance for working in this repo. Read this before making changes.

## ⚠️ Golden rule: keep the README current

**After every change that affects features, architecture, commands, data model, permissions, or the AI toolset, update [README.md](README.md) in the same session.** The README is the single source of truth for what the app does and how it's built — treat "code changed but README didn't" as an incomplete task. Touch the relevant section(s): Features, AI Assistant (tool tables), Stack, Project layout, migrations, capabilities, or Limitations.

## What this is

A local-first personal life-management desktop app — **Calendar, Reminders, To-Do, Notes, People** in one integrated tool, plus an optional AI assistant. Single user, offline, no accounts, no cloud sync. Tauri v2 (Rust shell) + React 19 + TypeScript + Vite + Tailwind + SQLite.

**People** are contacts modeled on **vCard 4.0 (RFC 6350)**: id = vCard UID (like events = iCal UID); multi-value fields (emails/phones/addresses/urls) + user-defined `custom_fields` are JSON columns on the `people` row (no child tables); a person attaches to any item via the existing `links` table and is tagged via `item_tags` (both accept `item_type='person'` — no schema change to them). See `003_people.sql`. `.vcf` import/export is future work but the schema maps straight to it — don't hand-roll a vCard parser when it lands (use a library, same as ICS).

**Custom-field labels are global.** The set of custom-field *labels* lives in the `person_custom_fields` table (`004_*.sql`) and is shared across all people — the People editor renders one row per registered label. Only the *value* is per-person (stored in that person's `custom_fields` JSON, keyed by label). So `ensureCustomField`/`deleteCustomFieldDef`/`reorderCustomFields` mutate the shared registry (deleting a label strips its value from every person), while editing a value just goes through the normal debounced `upsertPerson`. When code (UI or the AI's `create_person`/`update_person`) writes a custom_field with a new label, register it as a def (`ensureCustomField`) so it shows up everywhere.

## Commands

```bash
npm run tauri dev      # run the native app (compiles Rust; first run is slow)
npm run dev            # frontend only in a browser (DB calls no-op outside Tauri)
npm run build          # tsc + vite build (frontend)
npx tsc --noEmit       # type-check only  — run this after every change
npx vite build         # bundle check     — run this after every change
cd src-tauri && cargo check   # Rust compile check (after touching Rust/plugins)
```

Always finish a change by running `tsc` **and** `vite build` (and `cargo check` if Rust changed). `tsconfig` has `noUnusedLocals`/`noUnusedParameters` on — no dead imports/vars.

**Final step — after everything else is done**, build and launch the packaged app so it's ready to smoke-test (and so features that only work in a bundle, e.g. microphone/voice which needs the merged `Info.plist`, actually run):

```bash
npm run tauri build
open "src-tauri/target/release/bundle/macos/Second Brain.app"
```

Runtime DB (macOS): `~/Library/Application Support/com.elliottjones.secondbrain/secondbrain.db`.

## Architecture principles (do not violate)

1. **Thin Rust.** `src-tauri/src/lib.rs` only wires plugins and registers migrations. All business logic is TypeScript. This keeps a future plain-browser / Windows build a packaging change, not a rewrite.
2. **`src/db.ts` is the only module that touches SQLite.** Everything else calls its functions. Don't scatter raw SQL through the UI. (Exception by design: `src/lib/ai.ts` runs some read-only/filtered SQL for the assistant's tools — keep new query logic there or in `db.ts`, not in views.)
3. **Keep domain tables separate; connect via `links` + `item_tags`.** Don't collapse events/todos/reminders/notes into one generic table.
4. **Schema is CalDAV-ready.** UUID text PKs double as iCalendar UIDs; events carry RFC 5545 fields; every syncable row has `created_at`, `updated_at`, and a `sequence` that increments on edit. Preserve this when adding fields.
5. **All event access goes through `src/lib/calendars.ts`.** Events now come from two backends — SQLite (the built-in calendar) and CalDAV (connected Apple calendars) — so views and `ai.ts` must call the aggregator, never `db.ts`'s event helpers or the CalDAV client directly. See the Calendars section below.

## Calendars (local + CalDAV)

```
  Calendar / Today / ai.ts  ──►  src/lib/calendars.ts  ──┬──► src/db.ts        (local, SQLite)
                                  (registry, merge,      └──► src/lib/caldav/  (remote, network)
                                   write routing)
```

- **`UnifiedEvent` (types.ts) is the event shape everywhere above the backends** — `EventRow` is now just the SQLite row. `EventOccurrence.event` is a `UnifiedEvent`, tagged with `source` (`local` | `caldav`) and `calendarId`, plus `href`/`etag` for remote writes. `localToUnified()` converts a row.
- **Remote events are fetched live and never stored in SQLite.** That's why this feature needed **no migration and no schema change** — and it's load-bearing, not incidental. Don't "helpfully" add a remote-events table; two-way sync with local caching is a separate, deliberate project (needs `ctag`/`sync-token` + a migration).
- **Calendar config lives in `localStorage`** via `settings.ts` (`getCalendarSettings`/`saveCalendarSettings`): the account (Apple ID + app-specific password, plaintext, same trade-off as the OpenAI key), the discovered calendars, per-calendar visibility, and `defaultCalendarId`. Not in the DB, so a demo reset doesn't wipe it.
- **Two expansion paths, on purpose.** Local events use `rrule` (`lib/recurrence.ts`) — they store a plain absolute DTSTART with nothing to resolve. Remote events use **ical.js** (`lib/caldav/ical.ts`) because they carry `DTSTART;TZID=…` + an embedded `VTIMEZONE`, and only ical.js resolves that to the right absolute instant. Don't unify these onto `rrule`; you'd silently break cross-timezone events. Don't hand-roll either.
- **Writes are ETag-guarded.** `If-Match` on PUT/DELETE, `If-None-Match: *` on create. A `412` becomes `ConflictError` and must surface to the user — never blind-retry without one.
- **Remote events have no local row**, so tags/links/people (keyed on a local event id) don't apply to them. `EventForm` hides those panels and `get_item` says so. Don't fake a local row to work around it.
- **Reads fail soft.** `getOccurrences` returns `{ occurrences, errors }`; a dead iCloud connection must never break the local calendar. Keep that contract when adding callers.
- **Writes emit UTC `DTSTART`, not `TZID`** (v1 — avoids having to generate a `VTIMEZONE`). Known consequence: re-saving a recurring Apple event that was authored with a `TZID` converts it to UTC, so it drifts by an hour across DST instead of holding its wall-clock time. Documented in the README limitations; emitting `TZID` + `VTIMEZONE` on write is the intended fix. Don't "fix" it by dropping the UTC conversion without also writing a VTIMEZONE — you'd produce floating times, which is worse.
- **To add another provider** (Google/Fastmail/generic): add a `provider` case in `discovery.ts`, a host in `capabilities/default.json`, and a Settings entry. The client itself is already generic CalDAV.

## Hard-won gotchas (these have bitten us)

- **Never edit an already-applied migration.** `tauri-plugin-sql` (sqlx) checksums each migration; modifying `001_init.sql` after it ran errors out on existing DBs. To change schema/seed data, **add a new migration** (`00N_*.sql`) and register it in `lib.rs`. Test it with `sqlite3` before shipping (apply 001…N in order to a temp DB).
- **`window.prompt()` does not work in Tauri's WKWebView** — it's a silent no-op returning null. Use an inline input or a `Modal` instead. `window.confirm()` and `window.alert()` *do* work.
- **Icons: `lucide-react` only. No emoji anywhere** in the UI (verified by grep in the past). Import named icons; size ~14–18.
- **Timezones.** Store ISO 8601 (usually UTC `Z`) in the DB; interpret and render in the machine's local zone (date-fns `format`). The demo seeder builds `Date`s from local components then `.toISOString()`. **The AI must emit local-offset ISO (e.g. `+08:00`), never `Z`** — `ai.ts` injects the current local time + timezone into the system prompt for this. A `Z` time from the model saves events at the wrong hour.
- **View mounting / refresh.** Only one main view is mounted at a time (conditional render in `App.tsx`); each view reloads its data on mount, so navigating away and back shows fresh data — no global refresh signal needed. **Do not** add a `key={version}` that bumps on every mutation (it remounts the view and wipes in-progress edits — this broke Notes typing). The `resetNonce` key exists *only* to force a remount after a demo-data reset; keep it changing rarely.
- **Note editor** keeps local state and **debounces DB writes (400ms)**, flushing on unmount. Don't revert it to save-per-keystroke.
- **New Tauri plugin?** Three steps: add the crate in `Cargo.toml`, `.plugin(...)` in `lib.rs`, and add the permission (with scope if needed) in `src-tauri/capabilities/default.json`. Missing capability = runtime "not allowed" error.
- **Calling external APIs** (e.g. OpenAI, iCloud): use `@tauri-apps/plugin-http`'s `fetch`, not the webview `fetch` — the latter is blocked by CORS from the `tauri://` origin. Scope the URL in capabilities. (Parsing the XML/ICS that comes back is ordinary JS — only the network hop needs to go through Rust.)
- **`reqwest` drops the `Authorization` header on cross-host redirects**, and iCloud *always* redirects the entry point to a per-user shard (`pNN-caldav.icloud.com`). So `davRequest` sets `maxRedirections: 0` and follows redirects by hand, re-attaching auth each hop. If you "simplify" that away you get a 401 that looks like bad credentials. Always issue requests to the absolute hrefs discovery returned.
- **iCloud needs an app-specific password** — a 2FA account cannot Basic-auth with the main Apple password. The Settings UI links users to `account.apple.com` for this; keep that guidance visible or connection failures look like a bug.
- **CalDAV responses are `207 Multi-Status`**, and a single `<response>` can carry both a `200` and a `404` propstat. Use `propstatOk()` to take the 200 block — reading properties off the response directly picks up junk.

## AI assistant (`src/lib/ai.ts`)

- **Tool-calling, not context-stuffing.** The model is given read + write tools and pulls/changes only what it needs via an agentic loop (capped at `MAX_TOOL_ROUNDS`). This scales to large datasets.
- **Read tools are filtered + paginated:** bounded `limit` (default 25, max 100), returning `total` + `truncated` so the model narrows filters instead of assuming it saw everything. Push filters into SQL / FTS; `search_events` only fully expands *recurring* events and pre-filters the rest by window.
- **Write tools (create/update)** do a partial merge (`"field" in args` distinguishes "clear to null" from "leave unchanged") and call the same `db.ts` upsert helpers so `sequence`/timestamps stay correct.
- **Delete tools** (`delete_todo/event/reminder/note/list`) reuse the `db.ts` delete helpers. Deletion is **permanent** — the system prompt makes the model confirm the exact item(s) before deleting. There is still no in-UI confirmation dialog; if you add one, that's a deliberate change (update the README). `delete_list` rehomes tasks and refuses to delete the last list.
- **To add a capability:** add an entry to the `TOOLS` array (OpenAI function schema) and a `case` in `executeTool`, plus a status string in `statusFor`. The loop handles multi-tool rounds automatically. Keep new tools scoped and, for reads, paginated.
- **People + linking tools:** `search_people`/`create_person`/`update_person`/`delete_person`, `get_item` supports `type:"person"`, `add_tag` accepts `person`, and generic `link_items`/`unlink_items` connect any two items via `links` (e.g. attach a person to an event). `update_person`'s array fields (emails/phones/etc.) **replace** the whole list — the prompt tells the model to `get_item` then send the merged list to add a single entry.
- **Calendar tools are multi-calendar.** `search_events` merges local (SQL-prefiltered + `rrule`) with remote (`getRemoteOccurrences`) and returns `calendar_id` + `calendar` per result; `list_calendars` advertises what exists. `create_event` takes an optional `calendar` **name** and otherwise uses `defaultCalendarId()`. `update_event`/`delete_event`/`get_item` take an optional `calendar_id` and go through `resolveEvent()`, which falls back to scanning calendars by UID when it's absent — pass `calendar_id` from search results to avoid that. All of them route through `lib/calendars.ts`, not `db.ts`.
- The model gets the current **date + timezone** in the system prompt every request — keep that. Settings (API key, model, voice) live in `localStorage` (`src/lib/settings.ts`), **not** the SQLite DB, so a demo reset doesn't wipe them.
- There is **no per-write confirmation dialog** today; the prompt tells the model to confirm ambiguous requests in chat. If adding confirmation UX, that's a deliberate change — update the README.

## Voice (`src/lib/voice.ts`)

- Voice is just an **I/O layer around `askAssistant()`** — transcript in as a normal user turn, text reply read out. Don't couple it to the agent logic.
- **STT:** `getUserMedia` + `MediaRecorder` in the webview → OpenAI Whisper via `plugin-http` (`/v1/audio/transcriptions`, covered by the existing `api.openai.com/*` scope — no new capability). Audio is multipart `FormData`; don't set `Content-Type` (the boundary is auto-added). WKWebView tends to record mp4/aac, so `preferredMime()` probes support and `extFor()` sets the right filename.
- **TTS:** system `speechSynthesis` (free, offline, portable). Strip markdown before speaking.
- **Behavior rule (no setting):** if the user spoke (voice turn), speak the reply; if they typed, reply in text only. `deliver(text, spoken)` carries this — don't reintroduce a "voice replies" toggle.
- **Interaction is push-to-talk** (click start / click stop). No hands-free/VAD yet — that's the planned phase 2.
- **macOS mic gotcha:** `getUserMedia` requires `NSMicrophoneUsageDescription` in `src-tauri/Info.plist` (Tauri merges it into the bundle) or the OS kills the app. Dev builds may not always pick it up — a packaged `tauri build` will. All three web APIs work in Chromium/WebView2/browsers, so voice stays portable.

## File map

```
src/
  db.ts            # data-access layer — ONLY module that touches SQLite
  types.ts         # domain types mirroring the schema + UnifiedEvent
  lib/
    recurrence.ts  # rrule (RFC 5545) expansion, local events — never hand-roll
    ics.ts         # ICS import/export (ical-generator / ical.js)
    calendars.ts   # calendar registry + local/remote merge + write routing
    caldav/        # CalDAV client (network, NOT SQLite — hence not in db.ts)
      client.ts    #   authenticated WebDAV requests (plugin-http) + XML helpers
      discovery.ts #   principal -> calendar-home -> calendar collections
      events.ts    #   calendar-query REPORT (read) + PUT/DELETE (write), ETags
      ical.ts      #   VEVENT <-> UnifiedEvent via ical.js (TZID-aware)
    notifications.ts  # poll-based due-item OS notifications
    format.ts      # date helpers (date-fns) + <input> value converters
    settings.ts    # localStorage: OpenAI key/model + calendar accounts
    ai.ts          # assistant: tool schemas + executors + agentic loop
    demo.ts        # reset + seed demo data (Shift+8+9 easter egg)
  components/      # ui.tsx (Modal/Button), Avatar, ItemMeta (Tags/Links/People
                   #   panels), EventForm
  views/           # Today, Calendar, Reminders, Todos, Notes, People,
                   #   Assistant, Settings, Search
src-tauri/
  src/lib.rs       # plugin wiring + migration registration (keep thin)
  migrations/00N_*.sql       # versioned, checksummed — add, never edit
                             #   (001 init, 002 lists, 003 people, 004 custom fields)
  capabilities/default.json  # plugin permissions (add scope for new plugins;
                             #   http scope covers api.openai.com + *.icloud.com)
```

## Conventions

- TypeScript + React function components; Tailwind utility classes (no separate CSS files beyond `index.css`).
- SQLite booleans are `0/1` integers; convert at the boundary.
- Reuse `db.ts` helpers and the shared `Modal`/`Button`/`PriorityFlag` primitives and the `TagEditor`/`LinksPanel` panels rather than re-implementing.
- Match the surrounding code's style and comment density.

## Don't

- Don't add Xcode/Swift/SwiftUI or any Apple-only API. Cross-platform web tech + Rust only. (iCloud is reached over plain CalDAV/HTTP — no Apple frameworks, so it stays portable.)
- Don't hand-roll iCalendar parsing, recurrence, or WebDAV XML — use the existing libraries/helpers.
- Don't cache remote calendar events to SQLite. Live fetch is the design; changing it is a migration-scale decision.
- Don't add cloud/account features beyond user-supplied CalDAV credentials (no app backend, no hosting, no developer-side config).
- Don't forget the README. (See top.)
