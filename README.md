# 🧠 Second Brain

A local-first personal life-management desktop app: **Calendar, Reminders, To-Do, Notes, and People** in one integrated tool, with an optional **AI assistant** that can answer questions about your data *and* create, update, or delete items on your behalf. Built with Tauri v2 + React + TypeScript + SQLite. Local-first and offline by default — no account, no cloud sync. The only network calls are the ones you opt into: OpenAI (assistant/voice) and your own **iCloud calendar** if you connect one.

## Stack

| Layer | Choice |
|-------|--------|
| Shell | Tauri v2 (Rust) |
| Frontend | React 19 + TypeScript + Vite + Tailwind CSS |
| Icons | `lucide-react` |
| Languages | `i18next` + `react-i18next` (English, 繁體中文) |
| Database | SQLite via `tauri-plugin-sql` (sqlx) |
| Notifications | `tauri-plugin-notification` |
| Recurrence | `rrule` (RFC 5545) for local events; `ical.js` for remote (TZID-aware) |
| ICS import/export | `ical-generator` (export) + `ical.js` (import) |
| Calendar sync | CalDAV (RFC 4791) over `tauri-plugin-http`; `ical.js` for VEVENT parse/serialize |
| File I/O | `tauri-plugin-dialog` + `tauri-plugin-fs` |
| Networking | `tauri-plugin-http` (bypasses webview CORS to reach OpenAI, iCloud, and a local Ollama server) |
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

Migrations are versioned and idempotent (managed by `tauri-plugin-sql`); they run automatically on startup. App **settings** (your OpenAI key + model, and your calendar-account configuration) live separately in the webview's `localStorage`, not in the database — so they survive a data reset and stay out of the syncable calendar data.

**Connected Apple calendars are not stored here.** They're fetched from iCloud live whenever the visible date range changes, and edits are written straight back — nothing is copied to disk. That's why connecting a calendar needs no migration and no schema change, and also why Apple events need a connection to show up (see [Limitations](#notes--current-limitations)).

## Features

- **Today** — dashboard of today's schedule (across every visible calendar), due/overdue tasks & reminders, pinned + recent notes, and upcoming birthdays. Schedule events and notes are clickable — they jump straight to that item.
- **Calendar** — month / week / day views, event CRUD, drag-to-reschedule (month view, non-recurring events), RRULE recurrence, all-day + color-coded events. Todos with due dates appear as dashed chips. A bottom bar (on every calendar view) has **ICS import/export**. Supports **multiple calendars** — the built-in one plus connected Apple/iCloud calendars — viewable individually or together (see below).
- **Apple Calendar (iCloud)** — connect your iCloud account in Settings and your Apple calendars appear alongside the built-in one, each with its own color and a visibility toggle so you can view them **individually or together**. Create, edit, delete, and skip-an-occurrence all write straight back to iCloud. When creating an event you pick its calendar; a **default calendar** setting decides where events land otherwise (including ones the assistant creates).
- **Reminders** — Apple-Reminders-style with a filter sidebar (**All / Scheduled / Flagged / Completed**, each with live counts). Due date + optional alert time, recurrence, priority, link to a to-do. Native OS notifications fire when due (polled once a minute while the app is open).
- **To-Do** — multiple lists (defaults: **Personal**, **Work**), inline list creation, subtasks, priority, due dates, drag-to-reorder, and "Convert to event". Incomplete tasks always sort above completed ones.
- **Notes** — markdown with live preview, pin, FTS5 full-text search. The editor holds local state and debounces saves, so typing stays smooth.
- **People** — a contacts book modeled on **vCard 4.0**: multiple emails/phones/addresses/websites (each with a type), structured name, nickname, organization, title, birthday, notes, favorite, a **profile photo**, and **user-defined custom fields** (e.g. "Eye color: Blue", drag to reorder). Custom-field **labels are global** — a field you add shows up on every person (each person keeps its own value). Because that makes deletion destructive, the ✕ on a field asks first, offering to either clear just this person's value or delete the field (and its data) for everyone. Master-detail with the same debounced auto-save as Notes (no Save button). Click an email/phone/website to open it (`mailto:`/`tel:`/browser). Upcoming birthdays surface on the Today dashboard.
- **Assistant** — an AI chat that answers questions about your data and can create, update, or delete items, by typing **or by voice** (see below).
- **Settings** — a sidebar splits configuration into **General** (language), **Assistant** (OpenAI key + model), **Voice** (speech-to-text model), **Calendars** (connect iCloud, pick visible calendars, set the default), and **Data** (back up, restore, and reset, see below).
- **Backup & restore** — **Settings → Data** exports *everything the app holds for you* — every event, reminder, to-do, note, person, list, tag and link — to a single JSON file, and imports one back. Import **replaces all current data** (there's a confirmation), then reloads. The **OpenAI key and iCloud account are deliberately excluded** — those device-bound secrets never travel in the backup file; non-secret preferences (UI language, model names, calendar visibility/default) are included. See `src/lib/backup.ts`.
- **Reset** — **Settings → Data** also has a **Reset all data** button that permanently deletes every event, reminder, to-do, note, person, list, tag and link (behind a confirmation), then reloads to a clean, empty app. It clears the same tables as a demo reset via `clearAllData` (`src/lib/demo.ts`); the OpenAI key and iCloud account are left untouched since they live in `localStorage`, not the database.
- **Languages** — the whole UI is available in **English** and **Traditional Chinese (繁體中文)**. Dates, times, the first day of the week, and relative labels ("tomorrow") follow the selected language via `Intl`; switching applies instantly with no restart. Set it in **Settings → General** (defaults to following your OS).
- **Integration** — shared tagging and generic `links` (any item ↔ any item) across all five types; a person can be attached to any event, to-do, reminder, or note (and shown/edited from either side). Global search across everything.

The UI uses a consistent modern icon set (`lucide-react`) throughout — no emoji.

## Languages (i18n)

The UI ships in **English** and **Traditional Chinese (繁體中文)**, built on **`i18next` + `react-i18next`**. Catalogs are plain JSON bundled at build time — there's no backend to fetch translations from, which suits an offline desktop app.

**Choosing a language:** *Settings → General*. The default follows your OS locale; only Traditional variants (`zh-Hant`/`zh-TW`/`zh-HK`) map to Chinese, since showing Traditional characters to a Simplified reader would be worse than English. Switching applies **instantly** — `useTranslation()` subscribes to i18next's `languageChanged`, so the tree re-renders without a restart.

**What follows the language:**

- **Dates and times** go through `Intl.DateTimeFormat`, not hardcoded patterns, so each locale gets its own conventions: `2:30 PM` vs `下午2:30`, `Jul 20, 2026` vs `2026年7月20日`, `1 PM` vs `下午1時`. Hardcoded `"MMM d"`-style patterns produce `7月 20` in Chinese where the correct form is `7月20日`.
- **The first day of the week** comes from the date-fns locale — Sunday for `en-US`, Monday for `zh-TW` — so the calendar grid and its weekday headers reorder.
- **Relative labels** ("today", "tomorrow", "in 5 days") use `Intl.RelativeTimeFormat`.
- **`<html lang>`** is set at runtime. This matters more than it looks: many CJK codepoints are Han-unified, and with a wrong or missing `lang` the renderer picks an arbitrary variant — a Traditional reader can end up seeing Japanese glyph forms.
- **Spoken replies** pick a voice by detecting the script of the reply text (see AI Assistant → Voice).

**Adding a language** is a translation job, not an engineering one: add a catalog under `src/locales/<code>/app.json`, add the code to `LANGUAGES` in `src/lib/i18n.ts`, and map it in `matchSystemLanguage`. Keys are **type-checked** — `src/@types/i18next.d.ts` derives the key union from the English catalog, so `t("typo.here")` is a compile error and English is the enforced source of truth.

**Deliberately left in English:** the assistant's `SYSTEM_PROMPT`, its tool schemas, and the tool-result error strings. Those are model-facing, not user-facing — translating them costs tokens and tool-selection accuracy, and the model paraphrases them into the user's language anyway. The demo dataset (Shift+8+9) is also English-only.

## Apple Calendar (CalDAV)

Connect your iCloud account and your Apple calendars work alongside the built-in **Second Brain** calendar. There is **no server, hosting, or developer configuration** — the app talks to iCloud's CalDAV endpoints directly using your own credentials.

**Setup (Settings → Calendar accounts):**

1. Create an **app-specific password** at [account.apple.com](https://account.apple.com/account/manage) → *Sign-In and Security* → *App-Specific Passwords*. Your normal Apple password will **not** work if you have two-factor authentication on (and you almost certainly do).
2. Enter your Apple ID + that app-specific password, then hit **Connect**. The app discovers your calendars and lists them.
3. Tick the calendars you want visible, and choose a **default calendar** for new events.

**What syncs:** title, start/end, all-day, recurrence (`RRULE`), skipped occurrences (`EXDATE`), location, description, and status. Real timezones are handled properly — an event authored in another zone (`DTSTART;TZID=…` with an embedded `VTIMEZONE`) resolves to the correct absolute instant and renders at the right wall-clock time locally.

**How it works:**

- **Live fetch, no local copy.** Events are read with a window-scoped CalDAV `calendar-query` `REPORT` whenever the visible date range changes, and written back with `PUT`/`DELETE`. Nothing is persisted to SQLite, so there's no migration, no schema change, and no stale-copy problem — but also no offline access to Apple events.
- **Conflict-safe writes.** Every write carries the event's `ETag` as `If-Match`. If the event changed on another device in the meantime the server returns `412` and the app tells you to reload rather than silently overwriting.
- **Fails soft.** If iCloud is unreachable or the credentials are wrong, the built-in calendar and every other feature keep working; the Calendar view shows a *"Some calendars unavailable"* chip instead of erroring.
- **Provider-agnostic seams.** The client is generic CalDAV behind a small provider abstraction (`src/lib/caldav/`), with iCloud the only implementation shipped. Google/Fastmail/Nextcloud/generic-URL accounts are a provider entry plus a capability scope.

`src/lib/calendars.ts` is the aggregation layer the UI and the assistant both call: it lists calendars, merges occurrences for a window, and routes each write to either `db.ts` (local) or the CalDAV client (remote).

## AI Assistant

An optional assistant that answers questions about your events, to-dos, reminders, notes, and people — and can also **create, update, link, and delete** them for you. Its text model runs on **either OpenAI (your own API key) or a local Ollama server** — your choice, set per-device.

**Setup:** open **Settings → Assistant** (sidebar, bottom) and pick a **provider**:
- **OpenAI** — paste your `sk-…` key → pick a model (default `gpt-4o-mini`) → Save.
- **Local (Ollama)** — run `ollama serve`, set the server URL (default `http://localhost:11434`), and pick a model from the auto-discovered list. **A tools-capable model is required** (e.g. `llama3.1`, `qwen2.5`) — the assistant is built entirely on tool calling, so a model without function-calling support can't answer. No key, no billing, fully offline. The app talks to Ollama's **native `/api/chat`** (not its OpenAI-compatible shim) so it can raise `num_ctx` to `8192`: the system prompt plus tool schema is ~7k tokens, over Ollama's 4k default, and on the shim those tools get truncated off silently — the model then replies as a generic chatbot with no idea it has tools.

Then open **Assistant** and try:
- *"What's due next week in Work?"* / *"Which notes mention the Q3 report?"* (read)
- *"Add a to-do to call the dentist tomorrow at 2pm"* / *"Mark 'Buy groceries' as done"* / *"Create a weekly team-lunch event on Fridays at noon"* (write)
- *"Add a contact for Alex Rivera at Acme, email alex@acme.com"* / *"Set Alex's eye color to blue"* / *"Add Alex to Friday's lunch"* (people + linking)
- *"Add lunch tomorrow at noon"* (lands in your **default** calendar) / *"Put it in my Work calendar instead"* (calendars)
- *"Delete the dentist to-do"* / *"Remove the team-lunch event"* (delete — it'll confirm the exact item first)

**How it works — tool calling, not context stuffing:** rather than sending your entire dataset with every request (which doesn't scale), the model is given a set of **tools** and pulls/changes only what it needs via an agentic loop (`src/lib/ai.ts`):

| Read tool | Purpose |
|------|---------|
| `get_overview` | counts, list/tag names, current time (cheap orientation) |
| `search_todos` | filter by query, list, status, priority, due-date range, tag |
| `search_events` | events in a date range **across every visible calendar** (recurring events expanded to occurrences) + query/calendar/tag |
| `list_calendars` | the available calendars (built-in + connected), which are visible/read-only, and which is the default |
| `search_reminders` | filter by query, status, flagged, date range, tag |
| `search_notes` | FTS5 keyword search (or recent), pinned filter |
| `search_people` | contacts by name/nickname/org/email/phone, tag filter |
| `get_item` | full detail of one item (incl. `person`, and events in a connected calendar) + its tags and linked items |

| Write tool | Purpose |
|------|---------|
| `create_todo` / `update_todo` | create or edit a task (incl. list, due date, priority, mark complete) |
| `create_event` / `update_event` | create or edit a calendar event **in any calendar** (incl. recurrence, all-day, location); new events use the default calendar unless a `calendar` name is given |
| `create_reminder` / `update_reminder` | create or edit a reminder (incl. alert time, recurrence, complete) |
| `create_note` / `update_note` | create or edit a markdown note |
| `create_person` / `update_person` | create or edit a contact (incl. emails/phones/addresses, birthday, and user-defined `custom_fields`; custom labels register globally) |
| `create_list` | add a new to-do list |
| `add_tag` | tag any item (incl. a person) |
| `link_items` / `unlink_items` | connect/disconnect any two items (e.g. attach a person to an event) |
| `delete_todo` / `delete_event` / `delete_reminder` / `delete_note` / `delete_person` | permanently delete an item |
| `delete_list` | delete a list (its tasks move to another list; can't delete the last list) |

| Presentation tool | Purpose |
|------|---------|
| `show_items` | display the items the reply is about as cards under the message (max 8; changes no data) |

**It looks things up itself.** Ask about your own data and the assistant searches for it before answering — it won't claim it doesn't know, and it won't ask permission to check first. A question that sounds like general knowledge ("when should I take my vitamins?") is treated as a question about *your* reminders and notes, so it searches and only says something's missing once a search actually comes back empty.

**Built to find things:** searches match **individual terms, not the whole phrase**. This matters because you rarely name an item the way it's stored — asking to delete "my lunch with Alex meeting" has to find the event titled "Lunch with Alex", and a whole-phrase match finds nothing there. Terms are ANDed first; if nothing matches every word, the search falls back to the closest partial matches and flags them, so the assistant asks which one you meant rather than acting on a loose guess. The calendar's default window also starts at **midnight today**, not the current moment, so something earlier today is still findable this afternoon (looking further back needs an explicit start date).

**Built to scale:** every read tool is filtered and paginated — bounded `limit` (default 25, max 100) — and returns a `total` count and `truncated` flag so the model knows when there's more and narrows its filters instead of assuming it saw everything. Nothing loads a whole table blindly: searches push filters into SQL, notes use the FTS index, and `search_events` only fully expands *recurring* local events while pre-filtering non-recurring ones by the requested window (connected calendars are filtered server-side by the CalDAV time-range query). Live tool activity ("Checking the calendar…", "Creating a to-do…") is shown while the assistant works.

**How replies read — prose plus cards:** the assistant answers in **one or two sentences of natural prose**, not a formatted data dump. It's told explicitly not to use tables, lists, or bold field labels: replies are often read aloud by the voice feature, where a numbered list with **Time:** sub-bullets is unlistenable. Numbers stay readable, though — phone numbers, times and prices appear as digits (`+1 555-010-2020`, `3pm`), never spelled out, even where the prose around them reads like speech. The detail lives in the UI instead — the model calls `show_items` with the items it's actually discussing, and those render as **clickable cards beneath the message**. Click one to jump straight to that item in its own view; the conversation is preserved when you navigate back.

Two things follow from this design. The cards are the model's *explicit* choice, so items it merely searched through don't clutter the reply — and each card **loads the item's own row to render itself**, so the times and titles shown are the real stored values rather than whatever the model wrote (and stay correct if the item has changed since). Recurring items show the **right occurrence**, not the series' origin: a card for a weekday standup or a daily 8am reminder shows today's instance, resolved by the app rather than left to the model to specify — and a repeating reminder isn't flagged overdue, since it recurs by design. This is prompt-governed, so tone is tuned in `SYSTEM_PROMPT` (`src/lib/ai.ts`), not in the UI.

Because writing a reply and calling a tool compete for the same step, the model skips `show_items` a fair fraction of the time no matter how the prompt is worded. So there's a **recovery round**: if a turn ends having looked items up but never shown them, the assistant re-asks once with only the `show_items` schema, requesting the item references alone. The reply you already have is never regenerated, and if the recovery call fails it's ignored — cards are an enhancement and never cost you an answer.

**Follow-ups understand "it".** The items shown as cards are remembered as context for the next message, so you can say *"delete it"*, *"move the lunch one to 1pm"*, or *"who's coming to that?"* without re-naming the item — the assistant resolves the reference to the exact card it just showed you, rather than guessing or searching again. (The confirm-before-deleting rule still applies.)

**Calendars and the assistant:** `search_events` covers the built-in calendar and every visible Apple calendar in one call, and the assistant can view, edit, and delete events in all of them. New events go to your **default calendar** unless you name another one ("put it in my Work calendar"). Two things it's told to be honest about: events in connected calendars have **no tags, links, or attached people** (those are local-only), and if a calendar can't be reached the tool reports `unavailable_calendars` so the assistant says which ones it couldn't see rather than implying it saw your whole schedule.

**Voice mode:** the Assistant has a mic button. Click it to start recording and click again to stop, **or hold the Space bar to talk and release to send** (as long as the text box isn't focused) — your speech is transcribed with **OpenAI Whisper** (`whisper-1` by default) and sent as a normal turn. **Talk to the assistant and it replies aloud** (your OS's built-in voice, Web Speech Synthesis); **type and it replies in text** — that's the whole rule, no toggle. Voice is just an I/O layer around the same tool-calling loop, so it can answer *and* create/update/delete items by voice. Choose the transcription model in **Settings → Voice**.

- Voice **input** sends audio to OpenAI (billed per minute); spoken **replies** are generated locally by your OS (free, offline). Transcription is OpenAI-only, so **voice input needs an OpenAI key even when the text assistant runs on Ollama** — the mic says so rather than failing silently.
- **Voice input requires a packaged build** (`npm run tauri build`), not `tauri dev`. macOS WKWebView only exposes `navigator.mediaDevices` when the running app is recognized as mic-capable, which needs the `NSMicrophoneUsageDescription` from the merged `src-tauri/Info.plist` — present only in a bundled `.app`. In the packaged app, the first voice attempt triggers the system mic prompt. In `tauri dev` the mic button shows a "not available in this environment" error.
- Recording/transcription/TTS all use standard web APIs (`getUserMedia`/`MediaRecorder`/`speechSynthesis`), so this stays portable to the browser/Windows builds.

**Write behavior & safety:**
- The assistant can **create, update, and delete**. Deletion is **permanent and irreversible**, so the system prompt tells the model to look up the exact item first and **confirm which item(s) it will delete** unless you've already named a specific one — and never to delete more than you asked for.
- The system prompt also instructs the model to look up an item's id before updating it, to **ask a clarifying question when a request is ambiguous** rather than guess, and to briefly **confirm what it created, updated, or deleted** afterwards (in one sentence, with the item shown as a card).
- Changes appear in the other views the next time you open them (each view reloads its data on navigation).
- Configuration is stored locally. Requests go via the Rust HTTP plugin, scoped to `api.openai.com`, `*.icloud.com`, and `localhost`/`127.0.0.1` (for Ollama) — so an OpenAI key is sent directly to OpenAI and never leaves the device for a local model.

Adding further capabilities later is just more entries in the `TOOLS` array and the `executeTool` switch — the agentic loop already handles multi-tool rounds.

## Demo data (easter egg)

Hold **Shift + 8 + 9** together anywhere in the app to open a "Load demo data?" prompt. Confirming **permanently deletes all current data** and seeds a realistic, cross-linked sample dataset (events, recurring events, to-dos with subtasks, reminders, notes, people with birthdays/custom fields, tags, and links — including people attached to events and tasks) — handy for exploring the app. Your API key is **not** affected (it lives in `localStorage`). See `src/lib/demo.ts`.

## Standards / sync

Calendar sync is built (**CalDAV, iCloud** — see above). The schema was designed for it, and remains CardDAV-ready for contacts:

- UUID primary keys double as iCalendar `UID`s (events) and vCard `UID`s (people).
- Events store RFC 5545 fields directly (`summary`, `dtstart`, `rrule`, `exdates`, `status`, `categories`, …).
- **People are modeled on vCard 4.0 (RFC 6350)** — `full_name`→`FN`, structured name→`N`, `emails`/`phones`/`addresses`/`urls`→`EMAIL`/`TEL`/`ADR`/`URL`, `birthday`→`BDAY`, `organization`/`title`→`ORG`/`TITLE`, tags→`CATEGORIES`, and user-defined `custom_fields`→`X-` extension properties. Multi-value fields are stored as JSON on the row (like `exdates`/`categories`), so a future `.vcf` import/export is a straight field mapping. **Profile photos are `PHOTO`** — stored inline as a data URI rather than as a file on disk, so a person is still one self-contained row; uploads are center-cropped and re-encoded to a 256px JPEG (~30 KB) because `listPeople` reads the column on every render.
- Every syncable row has `created_at`, `updated_at`, and a `sequence` that increments on edit (mirrors iCalendar `SEQUENCE` / vCard `REV`).
- **Export to `.ics`** (Calendar → bottom bar → Export) proves the schema is standards-compliant — drag the file straight into Apple Calendar. Import reads events back, preserving UIDs. (vCard `.vcf` import/export is future work; the schema already maps to it.)

## Project layout

```
src/
  db.ts                 # data-access layer (only module that touches SQLite)
  types.ts              # domain types mirroring the schema
  locales/
    en/app.json         # translation catalogs (English is the source of truth)
    zh-TW/app.json
  @types/
    i18next.d.ts        # typed translation keys (a typo is a compile error)
  lib/
    i18n.ts             # i18next setup, language detection, <html lang>
    recurrence.ts       # rrule expansion (local events)
    ics.ts              # ICS import/export
    backup.ts           # full-data JSON backup/restore (all tables + non-secret settings)
    calendars.ts        # calendar registry + local/remote aggregation & write routing
    caldav/
      client.ts         # authenticated WebDAV requests + XML helpers
      discovery.ts      # principal -> calendar-home -> calendar collections
      events.ts         # calendar-query REPORT (read) + PUT/DELETE (write), ETags
      ical.ts           # VEVENT <-> UnifiedEvent via ical.js (TZID-aware)
    notifications.ts    # due-item notification poller
    format.ts           # date helpers
    settings.ts         # app settings (OpenAI key/model, voice, calendar accounts)
    ai.ts               # AI assistant: read + write tools + agentic loop
    voice.ts            # mic recording, Whisper transcription, system TTS
    demo.ts             # reset + seed demo data
  components/
    ui.tsx              # Modal, Button, priority helpers
    Avatar.tsx          # contact avatar (photo or initials)
    PhotoPicker.tsx     # avatar + profile-photo upload (crop/downscale)
    ItemMeta.tsx        # shared Tags + Links + People panels
    ItemCard.tsx        # item row: search results + assistant chat cards
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
    004_person_custom_fields.sql  # global custom-field label registry
    005_fts_trigram.sql     # rebuild notes FTS with the trigram tokenizer (CJK)
  capabilities/default.json  # plugin permissions (sql, notification, dialog,
                             #   fs scope, http scope for api.openai.com +
                             #   caldav.icloud.com / *.icloud.com)
CLAUDE.md              # architecture, conventions & gotchas for contributors
```

## Contributing / development

See [CLAUDE.md](CLAUDE.md) for architecture principles, conventions, and the gotchas that have bitten us (migrations are checksummed, `window.prompt` doesn't work in the webview, timezone handling, the view-remount pattern, adding AI tools, etc.). Please run `tsc` and `vite build` (and `cargo check` if Rust changed) before considering a change done — **and keep this README up to date with every change.**

## Notes / current limitations

- The AI assistant can read, create/update, **and delete** data, and requires your own OpenAI API key. It acts without a per-change confirmation *dialog* — it relies on the model to confirm ambiguous or destructive requests in chat first — so review what it reports, especially deletions (which are permanent). Replies are non-streaming (the whole answer appears once ready).
- Voice input is **push-to-talk** (click to start/stop) — no hands-free/continuous mode or silence auto-stop yet. It **only works in a packaged build** (`tauri dev` can't access the mic — see the Setup section), needs microphone permission, and sends audio to OpenAI for transcription. Spoken-reply voice quality depends on the OS's installed voices.
- Desktop notifications are **poll-based** (checked every 60s while the app is open) — the plugin has no cross-platform "schedule for later" API. Alerts won't fire while the app is closed.
- Drag-to-reschedule is day-granularity in month view and disabled for recurring series (dragging a single instance is ambiguous; edit the series, or use "Skip this day").
- **Apple calendars need a connection** — they're fetched live and never cached to disk, so they don't appear offline (the built-in calendar is unaffected). This is the deliberate trade for having no local copy to keep in sync.
- **Apple events can't carry tags, links, or people.** Those live in SQLite keyed by a local event id, and a connected event has no local row. The event editor hides those panels for remote events.
- **Global search covers local events only.** CalDAV has no unbounded keyword search, so searching connected calendars means naming a date window — which the assistant's `search_events` does, but the global search bar doesn't.
- **Moving an event between calendars isn't supported in-app** — the calendar picker is fixed once an event exists, because copy-then-delete would silently drop a local event's tags, links, and people. Delete it and recreate it in the target calendar.
- Remote **timed** events are written in UTC (unambiguous, avoids emitting a `VTIMEZONE`); all-day events use `VALUE=DATE`. Reading is fully `TZID`-aware. **One consequence worth knowing:** editing an existing *recurring* Apple event rewrites its `DTSTART` from the original `TZID` to UTC, so a series pinned to a wall-clock time (a 9am weekly standup) will shift by an hour across a daylight-saving boundary instead of staying at 9am. Editing non-recurring events, and creating new ones, are unaffected. Emitting `TZID` + `VTIMEZONE` on write is the fix and is planned.
- Per-instance `RECURRENCE-ID` overrides, attendees, and `VALARM` alarms are not synced — an event with per-instance overrides shows its series pattern, and editing it would drop the overrides.
- Local events have no timezone handling beyond the machine's local zone (fine for single-user local use; remote events *are* resolved from their source zone).
- **Chinese notes search needs 3+ characters to be ranked.** The notes index uses SQLite FTS5's `trigram` tokenizer, which can't answer queries shorter than 3 characters — and the commonest Chinese words are exactly 2 (北京, 會議). Those queries fall back to a `LIKE` scan, which is correct but unranked and slower on large note sets.
- **A custom (non-preset) RRULE is described in English** even in Chinese. `rrule`'s `toText()` substitutes token by token, and Chinese word order differs enough ("every week on Monday" vs 每週一) that the output would read worse than English. The repeat presets themselves are translated, which covers the common cases.
- The demo dataset and the assistant's own prose are **English-only**; the assistant replies in whatever language you write to it in.
- The OpenAI API key **and the iCloud app-specific password** are stored in plaintext in `localStorage` (typical for a local single-user app); anyone with access to the machine profile can read them. Moving credentials to the OS keychain is future work.
