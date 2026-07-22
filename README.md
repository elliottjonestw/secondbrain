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
| Voice | `getUserMedia`/`MediaRecorder` + OpenAI Whisper (STT); OpenAI `audio/speech` or Web `speechSynthesis` (TTS) |

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

> **In progress: moving to a Cloudflare backend.** Data currently lives only on
> the device that created it, which means it can't follow you between devices.
> The `cloud-migration` branch is replacing the local SQLite file with a
> Cloudflare D1 database behind a Workers API, with user accounts (register /
> sign in) and a local read cache. See
> [`docs/cloud-migration-plan.md`](docs/cloud-migration-plan.md) for the design
> and [`worker/README.md`](worker/README.md) for the backend.
>
> **Every domain now lives in the cloud.** M0 built the infrastructure and the
> multi-tenant schema; M1 added accounts; M2–M4 moved all the data —
> to-dos, lists, reminders, people, events, tags, links, and notes — to
> **Cloudflare D1**, reached through a typed Worker API, with **note-image
> bytes in Workers KV** (D1 caps a row at 2 MB). Everything syncs across
> devices; reads fall back to a local IndexedDB cache when offline, and writes
> are disabled offline and say so.
>
> The whole backend runs on **free-plan products with no payment method on the
> account**, which is a deliberate safety property rather than a cost-saving
> one: free plans return quota errors instead of billing overages, so a traffic
> spike — including a malicious one — can take the app offline until the daily
> counter resets, but can never produce a bill. That is why note images use KV
> (included free, no card) rather than R2, which requires a card on file even to
> use its own free tier. The cost of that choice is a 1 GB image budget and
> 1,000 uploads/day.
>
> **The local SQLite stack is gone.** `tauri-plugin-sql`, `browserDb.ts`,
> `src-tauri/migrations/`, the demo seeder and the `sql:*` capabilities have all
> been deleted, and `lib.rs` is plugin wiring only — architecture rule 1 held
> more completely than before the migration, and the side effect is that iOS is
> unblocked (`tauri-plugin-sql` never supported it). Backup/restore and
> Settings' "clear all data" are now server-side: a *logical* export that walks
> the tables one page at a time, because `wrangler d1 export` refuses a database
> containing virtual tables and `notes_fts` is one.
>
> **Still to do:** baking the deployed Worker URL into production builds
> (`VITE_API_URL`) so a shipped DMG/EXE reaches Cloudflare instead of
> `localhost`. The dev app already runs both together (`npm run tauri dev`
> starts the Worker via `dev:app`). Then M5: password reset and email
> verification — **nobody else should register until those exist**, because a
> forgotten password currently means a lost account.
>
> **The app is no longer standalone.** It now depends on the deployed Worker
> being reachable — no Worker, no login. That is the trade the cloud migration
> makes for cross-device sync.
>
> **Passwords are never sent to the server.** The client derives an argon2id key
> from your password and sends only that; the server stores a keyed hash of it.
> This is the same design Bitwarden and 1Password use. It means offline
> cracking resistance is unchanged while the server never sees a plaintext
> password — and it fits Cloudflare's free plan, whose 10 ms CPU cap per request
> cannot accommodate a correctly tuned password hash.
>
> **There is no password reset yet** (planned for M5). Until then a forgotten
> password means an unrecoverable account — the sign-up screen says so.

A single SQLite file, `secondbrain.db`, in Tauri's app-data directory:

- macOS: `~/Library/Application Support/com.elliottjones.secondbrain/`

Migrations are versioned and idempotent (managed by `tauri-plugin-sql`); they run automatically on startup. App **settings** (your OpenAI key + model, your calendar-account configuration, your weather location, and your stock watchlist) live separately in the webview's `localStorage`, not in the database — so they survive a data reset and stay out of the syncable calendar data.

**Note images are stored in their own table, not in the note text.** The markdown body holds only a reference (`![alt](sbimg:<id>)`); the bytes live in `note_images` and are read only by the preview that renders them. Inlining them as data URIs would put every image on the `notes` row — which the sidebar re-reads on every keystroke in the search box — and feed them to a *trigram* full-text index. Measured on one 300 KB image, that's a 638 KB search index versus 331 bytes.

**Connected Apple calendars are not stored here.** They're fetched from iCloud live whenever the visible date range changes, and edits are written straight back — nothing is copied to disk. That's why connecting a calendar needs no migration and no schema change, and also why Apple events need a connection to show up (see [Limitations](#notes--current-limitations)).

## Features

- **Today** — dashboard of the day's schedule (across every visible calendar), due/overdue tasks & reminders, pinned + recent notes, and upcoming birthdays. Schedule events and notes are clickable — they jump straight to that item. **Arrows beside the date step to any other day** (with a "Today" button to come back); the schedule, due items and birthdays follow it, while "overdue" only ever counts against *now*, so it pulls extra items in on today alone. When the assistant is configured, a **written summary of the day** appears as its own card — see below. A fresh install starts with **New York** as the weather location and **Apple + Alphabet** on the stock watchlist, so both tiles are there on day one; change or clear them in Settings. The forecast tile joins the grid whenever a location is set, following the day you're looking at; and a market ticker joins it whenever the **stock watchlist** is non-empty (today only — a quote describes now, so it says nothing about any other day). **Edit** opens a card manager: reorder the cards with the arrows, or hide the ones you don't want — and a hidden card stops fetching, so switching off the summary or the weather stops the request as well as the tile.
- **Calendar** — month / week / day views, event CRUD, RRULE recurrence, all-day + color-coded events. Todos with due dates appear as dashed chips. A bottom bar (on every calendar view) has **ICS import/export** on the left, with the export path and any calendar-unavailable warning on the right (the bottom-right corner belongs to the assistant's floating button). Supports **multiple calendars** — the built-in one plus connected Apple/iCloud calendars — viewable individually or together (see below).
- **Apple Calendar (iCloud)** — connect your iCloud account in Settings and your Apple calendars appear alongside the built-in one, each with its own color and a visibility toggle so you can view them **individually or together**. Create, edit, delete, and skip-an-occurrence all write straight back to iCloud. When creating an event you pick its calendar; a **default calendar** setting decides where events land otherwise (including ones the assistant creates).
- **Reminders** — Apple-Reminders-style with a filter sidebar (**All / Scheduled / Flagged / Completed**, each with live counts). Due date + optional alert time, recurrence, priority, link to a to-do. Native OS notifications fire when due (polled once a minute while the app is open).
- **To-Do** — multiple lists (defaults: **Personal**, **Work**), inline list creation, subtasks, priority, due dates, reordering (▲/▼ on hover), and "Convert to event". Incomplete tasks always sort above completed ones.
- **Notes** — markdown with live preview, pin, FTS5 full-text search. The editor holds local state and debounces saves, so typing stays smooth. A **formatting toolbar** sits above the text while editing (bold, italic, strikethrough, H1–H3, bullet/numbered/checklist, link, inline code, quote) — buttons act on the current selection, line markers apply to every line the selection touches and toggle off when re-applied, and **⌘/Ctrl+B, +I and +K** do bold, italic and link from the keyboard. The toolbar is hidden in preview mode. **Tables** go in from the toolbar's grid button: a dialog opens with a drag-to-size grid (up to 8×8, the Word/Docs gesture), number fields for anything larger or for keyboard use, and left/centre/right column alignment. It inserts a GFM table skeleton with a header row and numbered `Header n` placeholders, padded so the markdown source stays readable when you edit the cells by hand. **Images** go in from the toolbar's picker or by pasting a screenshot straight into the text; they're downscaled to 1600px and re-encoded as JPEG on the way in, and they render in the preview. **YouTube videos** go in too: paste a video's "Copy embed code" `<iframe>` straight into the text, or use the toolbar's ▶ button (which also accepts a plain link), and the preview shows the video with a play button; clicking it opens the video in your browser. What's stored is just the video's URL on its own line — so any bare YouTube link in a note becomes a video, while a link you've labelled (`[watch this](…)`) stays an ordinary link. The video opens in your browser rather than playing inside the note because YouTube's embedded player refuses to load without an HTTP `Referer`, which a packaged Tauri app — served from `tauri://localhost` — cannot give it ([tauri#14422](https://github.com/tauri-apps/tauri/issues/14422)). An in-app window doesn't help: the embedded player returns the same "Error 153" even when it *is* the page, so the only thing that actually plays is YouTube in a real browser. A **mic button in the bottom-right corner of the editor** dictates into the note: click to record, click again to stop, and the speech is transcribed with **OpenAI Whisper** (the same path the assistant uses, so it needs an OpenAI API key). A marker goes in at the cursor the moment recording starts and is replaced by the transcript when it arrives, so the text lands where you started talking even if you keep typing meanwhile.
- **People** — a contacts book modeled on **vCard 4.0**: multiple emails/phones/addresses/websites (each with a type), structured name, nickname, organization, title, birthday (the profile also shows the **age** derived from it), notes, favorite, a **profile photo**, and **user-defined custom fields** (e.g. "Eye color: Blue", reorderable with ▲/▼). Custom-field **labels are global** — a field you add shows up on every person (each person keeps its own value). Because that makes deletion destructive, the ✕ on a field asks first, offering to either clear just this person's value or delete the field (and its data) for everyone. Master-detail with the same debounced auto-save as Notes (no Save button). **Selecting a person opens a read-only profile** — only filled-in fields are shown — and **Edit** switches to the form; a person you've just created opens straight in the form, the same rule the Notes editor uses. Click an email/phone/website to open it (`mailto:`/`tel:`/browser), from either mode. Tags and links stay visible in both. Upcoming birthdays surface on the Today dashboard.
- **Weather** — an optional forecast tile on Today: condition, high/low and chance of rain, an **hour-by-hour strip** for the rest of the day, and a stat row with **feels-like, humidity, wind, UV index, air quality (US AQI) and daylight hours** — for whichever day you're viewing. Feels-like is often the number that matters: in a humid summer it runs several degrees above the air temperature. Air quality comes from Open-Meteo's separate (equally keyless) air-quality service and only applies to today, since it's a live reading. Data comes from [Open-Meteo](https://open-meteo.com), which needs **no account, no API key and no registration** — you pick a location in Settings and that's the whole setup. Nothing is written to the database: forecasts are fetched live and cached in `localStorage` for half an hour, the same rule connected calendar events follow. Celsius or Fahrenheit is a setting; with no location set, the tile doesn't exist.

- **Stocks** — an optional market ticker on Today, in the spirit of the iOS Stocks widget: one row per symbol with the ticker, its name, an **intraday sparkline drawn against the previous close**, the current price in its own currency, and the day's move as a signed percentage (green up, red down). A **Closed** marker appears when that market isn't trading, which for a watchlist spanning several exchanges is most of the time. A new install is seeded with Apple and Alphabet; search for a company or ticker in Settings to add more, reorder with the arrows, and the card follows that order — equities, ETFs and indices all work, on any exchange the provider covers (an index level renders as a plain number, not an amount of money). Like the forecast, nothing is written to the database: quotes are fetched live and cached in `localStorage` for five minutes while a market is open and half an hour once it has closed, since a closed market's number cannot change. With an empty watchlist the card doesn't exist, and the card only renders on today.

  A caveat worth stating plainly: quotes come from **Yahoo Finance's chart endpoint, which needs no account and no API key** — but unlike Open-Meteo it is *undocumented*, with no published terms and no stability guarantee, so it may change or stop working without notice. It was chosen because no keyless, documented equity API currently exists: Stooq (the closest match to how Open-Meteo was picked) is now behind a bot check, and Alpha Vantage, Finnhub, Twelve Data, marketstack and FMP all require registration. All of it is isolated in `lib/stocks.ts`, so replacing the provider is one file; and the card fails soft — an unreachable service shows "Couldn't reach the markets" inside that tile and nothing else on the page notices.
- **Assistant** — an AI chat that answers questions about your data and can create, update, or delete items, by typing **or by voice** (see below). It's reachable two ways: its own page, or a **floating chat window** available from every other page (see below).
- **Settings** — a sidebar splits configuration into **General** (language, weather location + temperature unit, stock watchlist), **Assistant** (OpenAI key + model, plus how long the Today briefing is held before it's rewritten), **Voice** (voice engine, spoken-reply voice, speaking rate, speech-to-text model), **Calendars** (connect iCloud, pick visible calendars, set the default), and **Data** (back up, restore, and reset, see below).
- **Backup & restore** — **Settings → Data** exports *everything the app holds for you* — every event, reminder, to-do, note, person, list, tag and link, including the images embedded in your notes — to a single JSON file, and imports one back. Import **replaces all current data** (there's a confirmation), then reloads. The **OpenAI key and iCloud account are deliberately excluded** — those device-bound secrets never travel in the backup file; non-secret preferences (UI language, model names, calendar visibility/default) are included. See `src/lib/backup.ts`.
- **Reset** — **Settings → Data** also has a **Reset all data** button that permanently deletes every event, reminder, to-do, note, person, list, tag and link (behind a confirmation), then reloads to a clean, empty app. It clears the same tables as a demo reset via `clearAllData` (`src/lib/demo.ts`); the OpenAI key and iCloud account are left untouched since they live in `localStorage`, not the database.
- **Languages** — the whole UI is available in **English** and **Traditional Chinese (繁體中文)**. Dates, times, the first day of the week, and relative labels ("tomorrow") follow the selected language via `Intl`; switching applies instantly with no restart. Set it in **Settings → General** (defaults to following your OS).
- **Integration** — shared tagging and generic `links` (any item ↔ any item) across all five types; a person can be attached to any event, to-do, reminder, or note (and shown/edited from either side). **Global search** covers everything — events (built-in *and* connected calendars), reminders, to-dos, notes and people — matching each word of the query separately rather than the whole phrase as one string, so "lunch with Alex meeting" still finds "Lunch with Alex". A recurring event appears once, dated to its next occurrence rather than to whenever the series began, and clicking any result opens it on the right day even if that's months away.

The UI uses a consistent modern icon set (`lucide-react`) throughout — no emoji.

## Languages (i18n)

The UI ships in **English** and **Traditional Chinese (繁體中文)**, built on **`i18next` + `react-i18next`**. Catalogs are plain JSON bundled at build time — there's no backend to fetch translations from, which suits an offline desktop app.

**Choosing a language:** *Settings → General*. The default follows your OS locale; only Traditional variants (`zh-Hant`/`zh-TW`/`zh-HK`) map to Chinese, since showing Traditional characters to a Simplified reader would be worse than English. Switching applies **instantly** — `useTranslation()` subscribes to i18next's `languageChanged`, so the tree re-renders without a restart.

**What follows the language:**

- **Dates and times** go through `Intl.DateTimeFormat`, not hardcoded patterns, so each locale gets its own conventions: `2:30 PM` vs `下午2:30`, `Jul 20, 2026` vs `2026年7月20日`, `1 PM` vs `下午1時`. Hardcoded `"MMM d"`-style patterns produce `7月 20` in Chinese where the correct form is `7月20日`.
- **The first day of the week** comes from the date-fns locale — Sunday for `en-US`, Monday for `zh-TW` — so the calendar grid and its weekday headers reorder.
- **Relative labels** ("today", "tomorrow", "in 5 days") use `Intl.RelativeTimeFormat`.
- **`<html lang>`** is set at runtime. This matters more than it looks: many CJK codepoints are Han-unified, and with a wrong or missing `lang` the renderer picks an arbitrary variant — a Traditional reader can end up seeing Japanese glyph forms.
- **Spoken replies** pick a voice by detecting the script of the reply text, then rank the installed voices for that language by quality (see AI Assistant → Voice).

**Adding a language** is a translation job, not an engineering one: add a catalog under `src/locales/<code>/app.json`, add the code to `LANGUAGES` in `src/lib/i18n.ts`, and map it in `matchSystemLanguage`. Keys are **type-checked** — `src/@types/i18next.d.ts` derives the key union from the English catalog, so `t("typo.here")` is a compile error and English is the enforced source of truth.

**Deliberately left in English:** the assistant's `SYSTEM_PROMPT`, its tool schemas, and the tool-result error strings. Those are model-facing, not user-facing — translating them costs tokens and tool-selection accuracy, and the model paraphrases them into the user's language anyway. The demo dataset (Shift+8+9) is also English-only.

## Apple Calendar (CalDAV)

Connect your iCloud account and your Apple calendars work alongside the built-in **Second Brain** calendar. There is **no server, hosting, or developer configuration** — the app talks to iCloud's CalDAV endpoints directly using your own credentials.

**Setup (Settings → Calendar accounts):**

1. Create an **app-specific password** at [account.apple.com](https://account.apple.com/account/manage) → *Sign-In and Security* → *App-Specific Passwords*. Your normal Apple password will **not** work if you have two-factor authentication on (and you almost certainly do).
2. Enter your Apple ID + that app-specific password, then hit **Connect**. The app discovers your calendars and lists them.
3. Tick the calendars you want visible, and choose a **default calendar** for new events.

**What syncs:** title, start/end, all-day, recurrence (`RRULE`), skipped occurrences (`EXDATE`), location, description, and status. Real timezones are handled properly — an event authored in another zone (`DTSTART;TZID=…` with an embedded `VTIMEZONE`) resolves to the correct absolute instant and renders at the right wall-clock time locally, and is written back in that same zone rather than flattened to UTC.

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
| `search_people` | contacts by name/nickname/org/email/phone, tag filter; a known birthday also returns a computed `age` and `next_birthday` |
| `get_item` | full detail of one item (incl. `person`, with the same computed `age`, and events in a connected calendar) + its tags and linked items |
| `get_weather` | one day's forecast for the weather location set in Settings — condition, high/low, feels-like, rain chance, wind, UV, sunrise/sunset, plus today-only "right now" temperature, humidity and air quality (optional hour-by-hour strip) |

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

**It knows what day it is.** Every request states today's date up front and repeats it next to your question, with the model told plainly that its training data is older than today and that the given date governs all arithmetic — ages, "how long ago", "how many days until". Dates the model would otherwise *calculate* are calculated by the app instead wherever possible: a contact's `age` and `next_birthday` come back already worked out from their birthday, since asked to subtract 1986 from the current year a model will happily answer with the year its training ended.

**Built to scale:** every read tool is filtered and paginated — bounded `limit` (default 25, max 100) — and returns a `total` count and `truncated` flag so the model knows when there's more and narrows its filters instead of assuming it saw everything. Nothing loads a whole table blindly: searches push filters into SQL, notes use the FTS index, and `search_events` only fully expands *recurring* local events while pre-filtering non-recurring ones by the requested window (connected calendars are filtered server-side by the CalDAV time-range query). Live tool activity ("Checking the calendar…", "Creating a to-do…") is shown while the assistant works.

**How replies read — prose plus cards:** the assistant answers in **one or two sentences of natural prose**, not a formatted data dump. It's told explicitly not to use tables, lists, or bold field labels: replies are often read aloud by the voice feature, where a numbered list with **Time:** sub-bullets is unlistenable. Numbers stay readable, though — phone numbers, times and prices appear as digits (`+1 555-010-2020`, `3pm`), never spelled out, even where the prose around them reads like speech. The detail lives in the UI instead — the model calls `show_items` with the items it's actually discussing, and those render as **clickable cards beneath the message**. Click one to jump straight to that item in its own view; the conversation is preserved when you navigate back.

Two things follow from this design. The cards are the model's *explicit* choice, so items it merely searched through don't clutter the reply — and each card **loads the item's own row to render itself**, so the times and titles shown are the real stored values rather than whatever the model wrote (and stay correct if the item has changed since). Recurring items show the **right occurrence**, not the series' origin: a card for a weekday standup or a daily 8am reminder shows today's instance, resolved by the app rather than left to the model to specify — and a repeating reminder isn't flagged overdue, since it recurs by design. This is prompt-governed, so tone is tuned in `SYSTEM_PROMPT` (`src/lib/ai.ts`), not in the UI.

Because writing a reply and calling a tool compete for the same step, the model skips `show_items` a fair fraction of the time no matter how the prompt is worded. So there's a **recovery round**: if a turn ends having looked items up but never shown them, the assistant re-asks once with only the `show_items` schema, requesting the item references alone. The reply you already have is never regenerated, and if the recovery call fails it's ignored — cards are an enhancement and never cost you an answer.

**Follow-ups understand "it".** The items shown as cards are remembered as context for the next message, so you can say *"delete it"*, *"move the lunch one to 1pm"*, or *"who's coming to that?"* without re-naming the item — the assistant resolves the reference to the exact card it just showed you, rather than guessing or searching again. (The confirm-before-deleting rule still applies.)

**Calendars and the assistant:** `search_events` covers the built-in calendar and every visible Apple calendar in one call, and the assistant can view, edit, and delete events in all of them. New events go to your **default calendar** unless you name another one ("put it in my Work calendar"). Two things it's told to be honest about: events in connected calendars have **no tags, links, or attached people** (those are local-only), and if a calendar can't be reached the tool reports `unavailable_calendars` so the assistant says which ones it couldn't see rather than implying it saw your whole schedule.

**The day summary on Today** is the same model but deliberately *not* the agentic loop. The Today page has already loaded exactly the day's events, due items and birthdays, so making the assistant search for facts already in hand would cost several round trips to learn nothing new. Instead the app builds a compact digest of that day and makes **one tool-free call** that only turns it into prose — with every fact the model is bad at (what's overdue, the age someone turns, whether the day is past or future) resolved in TypeScript beforehand, and the day's tense stated outright so a briefing about next Tuesday doesn't read as if it were happening now. If a weather location is set, that day's forecast goes into the same call — the briefing mentions it only when it would change what you do (rain, a storm, an unusually hot or cold day, air quality above US AQI 100, plans that look outdoor), and prefers the feels-like temperature to the air temperature when they diverge rather than reciting a forecast that already has its own tile. Summaries are written in your UI language and **cached per day**, against both a signature of that day's contents and the time they were written: stepping between days or leaving and returning costs nothing, while adding an event regenerates it — but only once the standing briefing is more than **6 hours old**. That hold is the one automatic billed request in the app, so without it a morning of ticking todos off buys a rewrite per tick; **Settings → Assistant** changes the number of hours or switches the hold off entirely for anyone who'd rather the card always be current. A failure is silent — the tiles below already show the same data — and there's a refresh button to rewrite one on demand. Empty days never call the model at all. The Today page shows nothing here if the assistant isn't configured.

**Ask from anywhere — the floating chat window.** Every page except the Assistant itself has a small button in the bottom-right corner that opens a chat window in the corner of that page, in the manner of a support widget: ask a question, get an answer, keep working — no navigation, and the page you were on stays exactly as you left it. It is the *same assistant*, not a cut-down one: the same tool-calling loop, the same item cards, the same mic and hold-Space-to-talk, the same spoken replies.

It is also the **same conversation** *and the same running turn*. Both live in one place regardless of which surface you typed into, so **Open in Assistant** is just navigation — there's nothing to hand over, the history is already there, and going the other way works too (start on the Assistant page, walk away to your calendar, and the popup picks up mid-thread). Switch surfaces a second after hitting send and the question, the thinking indicator and its Stop button all move with you; the answer arrives wherever you've ended up. Clicking an item card navigates to that item and **leaves the window open**, since staying on your page with the chat up is the entire point. Escape cancels a running turn if there is one, and closes the window if there isn't. The button doesn't appear until the assistant is configured — a button on every page that only says "go to Settings" is noise — and closing the window discards a half-finished recording rather than leaving the mic open behind a collapsed window.

Note the one deliberate cost: while the window is open, **hold-Space-to-talk is live app-wide**. Space still types and still activates a focused button or link, but on a page where it would otherwise scroll, holding it now records. That's the price of full voice parity in the popup, and it's scoped to the window being open.

**Voice mode:** the Assistant has a mic button. Click it to start recording and click again to stop, **or hold the Space bar to talk and release to send** (as long as the text box isn't focused) — your speech is transcribed with **OpenAI Whisper** (`whisper-1` by default) and sent as a normal turn. **Talk to the assistant and it replies aloud**; **type and it replies in text** — that's the whole rule, no toggle. Voice is just an I/O layer around the same tool-calling loop, so it can answer *and* create/update/delete items by voice. Choose the transcription model in **Settings → Voice**.

**Two voice engines:** spoken replies come from either **OpenAI's neural voices** (default) or the **OS's own voices**, chosen in Settings → Voice. Natural voices reuse the API key that's already there for the assistant and transcription, so they add no new account, and Chinese replies are steered toward **Taiwanese Mandarin** via the model's `instructions` field — the voices are multilingual but drift to mainland Putonghua without it. They're billed per character (order of a cent a minute) and need the network. **The system voice is always the fallback**, and any failure — offline, no key, rate limit — drops to it silently rather than losing the reply; Settings reports afterwards that it happened, since otherwise the only symptom is a suddenly robotic voice. Choosing "System (offline)" keeps spoken replies local, offline and free.

**One voice setting, except where the platform forbids it.** OpenAI's voices are multilingual, so "Natural" exposes a *single* voice picker that reads both English and Chinese, and the offline fallback quietly auto-selects the best installed voice. System voices are the opposite — each one speaks exactly one language, and an English voice handed Chinese text is **silent, with no error** — so "System" is the one mode that still shows a picker per language. That asymmetry is forced by the Web Speech API, not a leftover.

**Spoken replies appear as they're read, not before.** Natural voices need a network round-trip to synthesise, so printing the reply the moment it arrived left it sitting on screen through a second or two of silence, as if the app were reading it back to you. The Assistant now holds the text until `onStart` fires. That makes speech a dependency of *seeing your answer*, so `voice.ts` guarantees `onStart` always fires and always precedes `onEnd` — including when there's no matching voice, no network, or an outright failure — and `AssistantView` keeps a 10s timeout plus a reveal-on-stop hook on top. Verified against every path: voice installed, no matching voice, OpenAI failure falling back, and empty reply text. A timing nicety must never be able to swallow a reply.

**Speaking rate** is a single slider in Settings → Voice (0.5×–2×, default 1×) that applies to whichever engine is active — `utterance.rate` for system voices, the `speed` parameter for OpenAI. The pace is *also* described in words in the `instructions` sent with each reply, but that's reinforcement, not the mechanism: measured on identical text, `speed` 1.6 alone cut 6.55s to 4.44s while the wording alone at `speed` 1.0 managed only 6.86s. Widely-repeated reports that `gpt-4o-mini-tts` ignores `speed` no longer hold. (`tts-1` is the reverse — it honours `speed` and rejects `instructions` outright, which is why `instructions` is only sent to `gpt-4o*` models.) Both Preview buttons take the slider's *live* value rather than the saved one, so a rate can be heard before it's committed.

> **Rejected: Microsoft Edge "Read Aloud".** It's free, needs no account, and has real `zh-TW` neural voices, so it was implemented first — but its synthesis endpoint returns an empty-bodied **403 to every request**, verified across both hosts (`speech.platform.bing.com`, `api.msedgeservices.com`), with and without the `Sec-MS-GEC` token, across five `Sec-MS-GEC-Version` strings, and with the Edge extension `Origin`. The voices-*list* endpoint still returns 200 with the same trusted token and the local clock is within a second of the server's, so the token and the time bucket are fine — this is deliberate hardening of the free synthesis path, matching [the long 403 history in `rany2/edge-tts`](https://github.com/rany2/edge-tts/issues/458). Don't reach for it again without re-testing.

**Choosing a system voice:** macOS ships a *compact* voice for every language and downloads the good ones on demand, so picking the first voice that matches the language gives you the robotic one even when a far better one is installed. Instead the app **ranks the installed voices** — exact language tag first (a `zh-TW` voice beats a higher-tier `zh-CN` one), then quality tier (Premium → Enhanced → Standard → Compact), with macOS's novelty voices ("Zarvox", "Bad News") excluded since they match `en` like any other. The tier is read from the parenthesised suffix on the voice name, the only signal the Web Speech API exposes. **Settings → Voice** lists the ranked voices per language with a **Preview** button, and defaults to "Best available" — a deliberate option rather than a hidden fallback, so it upgrades itself when you install a better voice. To get one: **System Settings › Accessibility › Spoken Content › System Voice › Manage Voices** (free download; Enhanced/Premium sound dramatically better than the default). Siri voices are *not* exposed to the Web Speech API, so they can't be used here.

- Voice **input** sends audio to OpenAI (billed per minute). Spoken **replies** are billed per character when using natural voices, or free and offline on system voices. Transcription is OpenAI-only, so **voice input needs an OpenAI key even when the text assistant runs on Ollama** — the mic says so rather than failing silently.
- **Voice input requires a packaged build** (`npm run tauri build`), not `tauri dev`. macOS WKWebView only exposes `navigator.mediaDevices` when the running app is recognized as mic-capable, which needs the `NSMicrophoneUsageDescription` from the merged `src-tauri/Info.plist` — present only in a bundled `.app`. In the packaged app, the first voice attempt triggers the system mic prompt. In `tauri dev` the mic button shows a "not available in this environment" error.
- Recording/transcription/TTS all use standard web APIs (`getUserMedia`/`MediaRecorder`/`speechSynthesis`/`Audio`), so this stays portable to the browser/Windows builds.

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

The repo is npm workspaces: the root package is the app, plus two workspaces
added by the cloud migration.

```
worker/                 # Cloudflare Worker — the API (see worker/README.md)
  migrations/           #   D1 schema; 0001 squashes local 001–007 + tenancy
  src/                  #   Hono app, error boundary, CORS, routes
packages/shared/        # types + zod schemas + normalization, imported by BOTH
                        #   the client and the Worker, as TypeScript source, so
                        #   the two cannot drift
src/
  db.ts                 # data-access facade. Todos+lists call the Worker;
                        #   other domains still use local SQLite (mid-migration)
  lib/
    api.ts              # the only path to the Worker: auth headers, token
                        #   refresh (deduplicated), offline detection
    auth.ts             # register / login / logout / restore, in UI terms
    authStore.ts        # session + current space on this device (swap this
                        #   one file for an OS keychain on mobile)
    kdf.ts              # client-side argon2id — the password never leaves here
    cache.ts            # IndexedDB snapshot of remote reads, for offline
    platform.ts         # isTauri(), split out to avoid an import cycle
  components/auth/
    AuthGate.tsx        # decides whether <App> mounts at all
  views/AuthView.tsx    # sign in / create account
worker/src/
  authorize.ts          # the single tenancy choke point (membership + role)
  db/                    # all SQL, every query scoped by space_id
  routes/spaces.ts       # /v1/spaces/:spaceId/(lists|todos)
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
    images.ts           # decode/downscale/re-encode (person photos, note images)
    settings.ts         # app settings (OpenAI key/model, voice, calendar accounts,
                        #   weather location + unit, stock watchlist)
    ai.ts               # AI assistant: read + write tools + agentic loop
    weather.ts          # Open-Meteo forecast, hourly, air quality + place search
                        #   (keyless, never stored)
    stocks.ts           # stock quotes + intraday series + symbol search
                        #   (keyless but undocumented, never stored)
    voice.ts            # mic recording, Whisper transcription, TTS engines + fallback
    openaiTts.ts        # OpenAI neural voices (natural spoken replies)
    demo.ts             # reset + seed demo data
  components/
    today/              # one file per Today widget + the registry they're
                        #   listed in; each fetches its own data and renders
                        #   inside an error boundary
    assistant/          # useAssistantChat (the turn + voice lifecycle) and the
                        #   pieces both surfaces render: MessageList, Composer,
                        #   AssistantPopup (the floating chat window)
    ui.tsx              # Modal, Button, priority helpers
    Avatar.tsx          # contact avatar (photo or initials)
    PhotoPicker.tsx     # avatar + profile-photo upload (crop/downscale)
    MarkdownToolbar.tsx # note formatting bar (selection/line transforms)
    DictateButton.tsx   # reusable mic button: record → Whisper → text
    NoteImage.tsx       # renders sbimg: refs in the note preview
    YouTubeEmbed.tsx    # bare YouTube URL → video card; opens in the browser
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
    006_note_images.sql     # note_images: image bytes referenced from note bodies
    007_unique_list_name.sql  # collapse duplicate list names, unique index on lists.name
  capabilities/default.json  # plugin permissions (sql, notification, dialog,
                             #   fs scope, http scope for api.openai.com +
                             #   caldav.icloud.com / *.icloud.com +
                             #   api.open-meteo.com / geocoding-api.open-meteo.com /
                             #   air-quality-api.open-meteo.com /
                             #   query1.finance.yahoo.com)
CLAUDE.md              # architecture, conventions & gotchas for contributors
```

## Contributing / development

See [CLAUDE.md](CLAUDE.md) for architecture principles, conventions, and the gotchas that have bitten us (migrations are checksummed, `window.prompt` doesn't work in the webview, timezone handling, the view-remount pattern, adding AI tools, etc.). Please run `tsc` and `vite build` (and `cargo check` if Rust changed) before considering a change done — **and keep this README up to date with every change.**

## Notes / current limitations

- The AI assistant can read, create/update, **and delete** data, and requires your own OpenAI API key. It acts without a per-change confirmation *dialog* — it relies on the model to confirm ambiguous or destructive requests in chat first — so review what it reports, especially deletions (which are permanent). Replies are non-streaming (the whole answer appears once ready).
- Voice input is **push-to-talk** (click to start/stop) — no hands-free/continuous mode or silence auto-stop yet. It **only works in a packaged build** (`tauri dev` can't access the mic — see the Setup section), needs microphone permission, and sends audio to OpenAI for transcription. Spoken-reply voice quality depends on the OS's installed voices — the app picks the best one installed and Settings lets you override it, but it can't improve on what macOS offers, and Siri voices aren't available to the Web Speech API. Genuinely neural TTS would mean a network voice or a bundled local model.
- Desktop notifications are **poll-based** (checked every 60s while the app is open) — the plugin has no cross-platform "schedule for later" API. Alerts won't fire while the app is closed.
- **There is no drag-and-drop anywhere in the app**, by decision rather than omission: HTML5 drag doesn't work in the WKWebView the packaged app runs in, and a drag handle that silently does nothing is worse than no handle. Reordering to-dos and custom fields is ▲/▼ buttons (which also work from a keyboard); rescheduling an event means opening it and changing the date.
- **Apple calendars need a connection** — they're fetched live and never cached to disk, so they don't appear offline (the built-in calendar is unaffected). This is the deliberate trade for having no local copy to keep in sync.
- **Apple events can't carry tags, links, or people.** Those live in SQLite keyed by a local event id, and a connected event has no local row. The event editor hides those panels for remote events.
- **Global search covers connected calendars only within a date window.** CalDAV has no unbounded keyword search — the only server-side filter is a time-range — so connected calendars are searched a year either side of today, widened in steps from a control under the results that names the range being searched. The built-in calendar has no such limit; it's SQLite, so it's searched over all time. An event in a connected calendar outside the window is missing rather than absent, which is why the range is stated rather than assumed.
- **Moving an event between calendars isn't supported in-app** — the calendar picker is fixed once an event exists, because copy-then-delete would silently drop a local event's tags, links, and people. Delete it and recreate it in the target calendar.
- Remote **timed** events keep the timezone they were authored in on write: re-saving an event that came from Apple writes `DTSTART;TZID=…` (and a matching `EXDATE;TZID=…`) with the original `VTIMEZONE` copied back in, so a 9am weekly standup stays at 9am across a daylight-saving boundary. All-day events use `VALUE=DATE`. **What's still UTC:** events whose source zone we never saw — chiefly **events created in the app**, which have no `TZID` of their own. The app ships no timezone database, and RFC 5545 requires the `VTIMEZONE` definition to travel with any `TZID` reference, so there's nothing honest to emit; a *new recurring timed* event therefore still drifts an hour across a DST change. Single events are unaffected either way (the instant is the same).
- Per-instance `RECURRENCE-ID` overrides, attendees, and `VALARM` alarms are not synced — an event with per-instance overrides shows its series pattern, and editing it would drop the overrides.
- Local events have no timezone handling beyond the machine's local zone (fine for single-user local use; remote events *are* resolved from their source zone).
- **Chinese notes search needs 3+ characters to be ranked.** The notes index uses SQLite FTS5's `trigram` tokenizer, which can't answer queries shorter than 3 characters — and the commonest Chinese words are exactly 2 (北京, 會議). Those queries fall back to a `LIKE` scan, which is correct but unranked and slower on large note sets.
- **A custom (non-preset) RRULE is described in English** even in Chinese. `rrule`'s `toText()` substitutes token by token, and Chinese word order differs enough ("every week on Monday" vs 每週一) that the output would read worse than English. The repeat presets themselves are translated, which covers the common cases.
- **Profile photos accept PNG/JPEG/WebP/GIF, not HEIC** — the webview can't decode HEIC, so a photo dragged straight out of Apple Photos is rejected with an error rather than silently failing; export it as JPEG first. Photos are stored inline on the person row, so they're included in a Settings → Data backup (and inflate the JSON by ~30 KB each) rather than living as separate files.
- The demo dataset and the assistant's own prose are **English-only**; the assistant replies in whatever language you write to it in.
- The OpenAI API key **and the iCloud app-specific password** are stored in plaintext in `localStorage` (typical for a local single-user app); anyone with access to the machine profile can read them. Moving credentials to the OS keychain is future work.
