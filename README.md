# 🧠 Second Brain

A local-first personal life-management desktop app: **Calendar, Reminders, To-Do, Notes, and People** in one integrated tool, with an optional **AI assistant** that can answer questions about your data *and* create, update, or delete items on your behalf. Built with Tauri v2 + React + TypeScript + SQLite. Fully offline (the only network call is to OpenAI, and only if you opt in) — no account, no cloud sync.

## Stack

| Layer | Choice |
|-------|--------|
| Shell | Tauri v2 (Rust) |
| Frontend | React 19 + TypeScript + Vite + Tailwind CSS |
| Icons | `lucide-react` |
| Database | SQLite via `tauri-plugin-sql` (sqlx) |
| Notifications | `tauri-plugin-notification` |
| Recurrence | `rrule` (RFC 5545) |
| ICS import/export | `ical-generator` (export) + `ical.js` (import) |
| File I/O | `tauri-plugin-dialog` + `tauri-plugin-fs` |
| AI networking | `tauri-plugin-http` (bypasses webview CORS to reach OpenAI) |
| Voice | `getUserMedia`/`MediaRecorder` + OpenAI Whisper (STT); Web `speechSynthesis` (TTS) |

The Rust side is intentionally thin — just plugin registration + versioned migrations (`src-tauri/src/lib.rs`, `src-tauri/migrations/`). **All business logic lives in TypeScript** (`src/db.ts` is the only module that touches the DB), so a plain-browser or Windows build later is a packaging change, not a rewrite.

## Prerequisites

- Node.js 18+ and npm
- Rust toolchain (`rustc` / `cargo`) — https://rustup.rs
- macOS: Xcode **Command Line Tools** only (`xcode-select --install`) — no Xcode IDE, Swift, or Apple frameworks used anywhere.

## Setup & run

```bash
npm install            # install JS deps (already done if you're reading this in-repo)
npm run tauri dev      # compile Rust + launch the native app (first run downloads crates, ~1–2 min)
```

Other commands:

```bash
npm run dev            # frontend only, in a browser at http://localhost:1420 (DB calls no-op outside Tauri)
npm run build          # type-check + build the frontend bundle
npm run tauri build    # produce a distributable macOS .app / .dmg
```

### Packaged build (required for voice / microphone)

`tauri dev` runs a bare binary with no merged `Info.plist`, so macOS WKWebView won't expose microphone access there — **voice input only works in a packaged build.** After finishing changes, build and launch the bundled app:

```bash
npm run tauri build
open "src-tauri/target/release/bundle/macos/Second Brain.app"
```

## Where your data lives

A single SQLite file, `secondbrain.db`, in Tauri's app-data directory:

- macOS: `~/Library/Application Support/com.elliottjones.secondbrain/`

Migrations are versioned and idempotent (managed by `tauri-plugin-sql`); they run automatically on startup. App **settings** (your OpenAI key + model) live separately in the webview's `localStorage`, not in the database — so they survive a data reset and stay out of the syncable calendar data.

## Features

- **Today** — dashboard of today's schedule, due/overdue tasks & reminders, pinned + recent notes. ICS import/export buttons.
- **Calendar** — month / week / day views, event CRUD, drag-to-reschedule (month view, non-recurring events), RRULE recurrence, all-day + color-coded events. Todos with due dates appear as dashed chips.
- **Reminders** — Apple-Reminders-style with a filter sidebar (**All / Scheduled / Flagged / Completed**, each with live counts). Due date + optional alert time, recurrence, priority, link to a to-do. Native OS notifications fire when due (polled once a minute while the app is open).
- **To-Do** — multiple lists (defaults: **Personal**, **Work**), inline list creation, subtasks, priority, due dates, drag-to-reorder, and "Convert to event". Incomplete tasks always sort above completed ones.
- **Notes** — markdown with live preview, pin, FTS5 full-text search. The editor holds local state and debounces saves, so typing stays smooth.
- **People** — a contacts book modeled on **vCard 4.0**: multiple emails/phones/addresses/websites (each with a type), structured name, nickname, organization, title, birthday, notes, favorite, and **user-defined custom fields** (add any label/value, e.g. "Eye color: Blue", drag to reorder). Master-detail with the same debounced auto-save as Notes (no Save button). Click an email/phone/website to open it (`mailto:`/`tel:`/browser). Upcoming birthdays surface on the Today dashboard.
- **Assistant** — an AI chat that answers questions about your data and can create, update, or delete items, by typing **or by voice** (see below).
- **Settings** — enter your OpenAI API key + model.
- **Integration** — shared tagging and generic `links` (any item ↔ any item) across all five types; a person can be attached to any event, to-do, reminder, or note (and shown/edited from either side). Global search across everything.

The UI uses a consistent modern icon set (`lucide-react`) throughout — no emoji.

## AI Assistant

An optional assistant that answers questions about your events, to-dos, reminders, notes, and people — and can also **create, update, link, and delete** them for you. Bring your own OpenAI API key.

**Setup:** open **Settings** (sidebar, bottom) → paste your `sk-…` key → pick a model (default `gpt-4o-mini`) → Save. Then open **Assistant** and try:
- *"What's due next week in Work?"* / *"Which notes mention the Q3 report?"* (read)
- *"Add a to-do to call the dentist tomorrow at 2pm"* / *"Mark 'Buy groceries' as done"* / *"Create a weekly team-lunch event on Fridays at noon"* (write)
- *"Add a contact for Alex Rivera at Acme, email alex@acme.com"* / *"Set Alex's eye color to blue"* / *"Add Alex to Friday's lunch"* (people + linking)
- *"Delete the dentist to-do"* / *"Remove the team-lunch event"* (delete — it'll confirm the exact item first)

**How it works — tool calling, not context stuffing:** rather than sending your entire dataset with every request (which doesn't scale), the model is given a set of **tools** and pulls/changes only what it needs via an agentic loop (`src/lib/ai.ts`):

| Read tool | Purpose |
|------|---------|
| `get_overview` | counts, list/tag names, current time (cheap orientation) |
| `search_todos` | filter by query, list, status, priority, due-date range, tag |
| `search_events` | events in a date range (recurring events expanded to occurrences) + query/tag |
| `search_reminders` | filter by query, status, flagged, date range, tag |
| `search_notes` | FTS5 keyword search (or recent), pinned filter |
| `search_people` | contacts by name/nickname/org/email/phone, tag filter |
| `get_item` | full detail of one item (incl. `person`) + its tags and linked items |

| Write tool | Purpose |
|------|---------|
| `create_todo` / `update_todo` | create or edit a task (incl. list, due date, priority, mark complete) |
| `create_event` / `update_event` | create or edit a calendar event (incl. recurrence, all-day, location) |
| `create_reminder` / `update_reminder` | create or edit a reminder (incl. alert time, recurrence, complete) |
| `create_note` / `update_note` | create or edit a markdown note |
| `create_person` / `update_person` | create or edit a contact (incl. emails/phones/addresses, birthday, and user-defined `custom_fields`) |
| `create_list` | add a new to-do list |
| `add_tag` | tag any item (incl. a person) |
| `link_items` / `unlink_items` | connect/disconnect any two items (e.g. attach a person to an event) |
| `delete_todo` / `delete_event` / `delete_reminder` / `delete_note` / `delete_person` | permanently delete an item |
| `delete_list` | delete a list (its tasks move to another list; can't delete the last list) |

**Built to scale:** every read tool is filtered and paginated — bounded `limit` (default 25, max 100) — and returns a `total` count and `truncated` flag so the model knows when there's more and narrows its filters instead of assuming it saw everything. Nothing loads a whole table blindly: searches push filters into SQL, notes use the FTS index, and `search_events` only fully expands *recurring* events while pre-filtering non-recurring ones by the requested window. Live tool activity ("Checking the calendar…", "Creating a to-do…") is shown while the assistant works.

**Voice mode:** the Assistant has a mic button (push-to-talk). Click it to record, click again to stop — your speech is transcribed with **OpenAI Whisper** (`whisper-1` by default) and sent as a normal turn. **Talk to the assistant and it replies aloud** (your OS's built-in voice, Web Speech Synthesis); **type and it replies in text** — that's the whole rule, no toggle. Voice is just an I/O layer around the same tool-calling loop, so it can answer *and* create/update/delete items by voice. Choose the transcription model in **Settings → Voice**.

- Voice **input** sends audio to OpenAI (billed per minute); spoken **replies** are generated locally by your OS (free, offline).
- **Voice input requires a packaged build** (`npm run tauri build`), not `tauri dev`. macOS WKWebView only exposes `navigator.mediaDevices` when the running app is recognized as mic-capable, which needs the `NSMicrophoneUsageDescription` from the merged `src-tauri/Info.plist` — present only in a bundled `.app`. In the packaged app, the first voice attempt triggers the system mic prompt. In `tauri dev` the mic button shows a "not available in this environment" error.
- Recording/transcription/TTS all use standard web APIs (`getUserMedia`/`MediaRecorder`/`speechSynthesis`), so this stays portable to the browser/Windows builds.

**Write behavior & safety:**
- The assistant can **create, update, and delete**. Deletion is **permanent and irreversible**, so the system prompt tells the model to look up the exact item first and **confirm which item(s) it will delete** unless you've already named a specific one — and never to delete more than you asked for.
- The system prompt also instructs the model to look up an item's id before updating it, to **ask a clarifying question when a request is ambiguous** rather than guess, and to briefly **confirm what it created, updated, or deleted** afterwards.
- Changes appear in the other views the next time you open them (each view reloads its data on navigation).
- The key is stored locally and sent directly to OpenAI (via the Rust HTTP plugin, scoped to `api.openai.com`).

Adding further capabilities later is just more entries in the `TOOLS` array and the `executeTool` switch — the agentic loop already handles multi-tool rounds.

## Demo data (easter egg)

Hold **Shift + 8 + 9** together anywhere in the app to open a "Load demo data?" prompt. Confirming **permanently deletes all current data** and seeds a realistic, cross-linked sample dataset (events, recurring events, to-dos with subtasks, reminders, notes, people with birthdays/custom fields, tags, and links — including people attached to events and tasks) — handy for exploring the app. Your API key is **not** affected (it lives in `localStorage`). See `src/lib/demo.ts`.

## Standards / future sync

The schema is deliberately CalDAV/CardDAV-ready even though sync isn't built yet:

- UUID primary keys double as iCalendar `UID`s (events) and vCard `UID`s (people).
- Events store RFC 5545 fields directly (`summary`, `dtstart`, `rrule`, `exdates`, `status`, `categories`, …).
- **People are modeled on vCard 4.0 (RFC 6350)** — `full_name`→`FN`, structured name→`N`, `emails`/`phones`/`addresses`/`urls`→`EMAIL`/`TEL`/`ADR`/`URL`, `birthday`→`BDAY`, `organization`/`title`→`ORG`/`TITLE`, tags→`CATEGORIES`, and user-defined `custom_fields`→`X-` extension properties. Multi-value fields are stored as JSON on the row (like `exdates`/`categories`), so a future `.vcf` import/export is a straight field mapping.
- Every syncable row has `created_at`, `updated_at`, and a `sequence` that increments on edit (mirrors iCalendar `SEQUENCE` / vCard `REV`).
- **Export to `.ics`** (Today → Export) proves the schema is standards-compliant — drag the file straight into Apple Calendar. Import reads events back, preserving UIDs. (vCard `.vcf` import/export is future work; the schema already maps to it.)

## Project layout

```
src/
  db.ts                 # data-access layer (only module that touches SQLite)
  types.ts              # domain types mirroring the schema
  lib/
    recurrence.ts       # rrule expansion
    ics.ts              # ICS import/export
    notifications.ts    # due-item notification poller
    format.ts           # date helpers
    settings.ts         # app settings (OpenAI key/model, voice) in localStorage
    ai.ts               # AI assistant: read + write tools + agentic loop
    voice.ts            # mic recording, Whisper transcription, system TTS
    demo.ts             # reset + seed demo data
  components/
    ui.tsx              # Modal, Button, priority helpers
    Avatar.tsx          # contact avatar (photo or initials)
    ItemMeta.tsx        # shared Tags + Links + People panels
    EventForm.tsx       # event create/edit
  views/                # Today, Calendar, Reminders, Todos, Notes, People,
                        #   Assistant, Settings, Search
src-tauri/
  src/lib.rs            # plugin wiring + migration registration (thin)
  Info.plist           # macOS NSMicrophoneUsageDescription (voice input)
  migrations/
    001_init.sql            # initial schema
    002_default_lists.sql   # seed Personal/Work, drop Inbox
    003_people.sql          # people (contacts, vCard 4.0-modeled)
  capabilities/default.json  # plugin permissions (sql, notification, dialog,
                             #   fs scope, http scope for api.openai.com)
CLAUDE.md              # architecture, conventions & gotchas for contributors
```

## Contributing / development

See [CLAUDE.md](CLAUDE.md) for architecture principles, conventions, and the gotchas that have bitten us (migrations are checksummed, `window.prompt` doesn't work in the webview, timezone handling, the view-remount pattern, adding AI tools, etc.). Please run `tsc` and `vite build` (and `cargo check` if Rust changed) before considering a change done — **and keep this README up to date with every change.**

## Notes / current limitations

- The AI assistant can read, create/update, **and delete** data, and requires your own OpenAI API key. It acts without a per-change confirmation *dialog* — it relies on the model to confirm ambiguous or destructive requests in chat first — so review what it reports, especially deletions (which are permanent). Replies are non-streaming (the whole answer appears once ready).
- Voice input is **push-to-talk** (click to start/stop) — no hands-free/continuous mode or silence auto-stop yet. It **only works in a packaged build** (`tauri dev` can't access the mic — see the Setup section), needs microphone permission, and sends audio to OpenAI for transcription. Spoken-reply voice quality depends on the OS's installed voices.
- Desktop notifications are **poll-based** (checked every 60s while the app is open) — the plugin has no cross-platform "schedule for later" API. Alerts won't fire while the app is closed.
- Drag-to-reschedule is day-granularity in month view and disabled for recurring series (dragging a single instance is ambiguous; edit the series, or use "Skip this day").
- No timezone handling beyond the machine's local zone (fine for single-user local use; revisit before CalDAV sync).
- The OpenAI API key is stored in plaintext in `localStorage` (typical for a local single-user app); anyone with access to the machine profile can read it.
