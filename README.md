# 🧠 Second Brain

A local-first personal life-management desktop app: **Calendar, Reminders, To-Do, and Notes** in one integrated tool. Built with Tauri v2 + React + TypeScript + SQLite. Fully offline, no account, no cloud.

## Stack

| Layer | Choice |
|-------|--------|
| Shell | Tauri v2 (Rust) |
| Frontend | React 19 + TypeScript + Vite + Tailwind CSS |
| Database | SQLite via `tauri-plugin-sql` (sqlx) |
| Notifications | `tauri-plugin-notification` |
| Recurrence | `rrule` (RFC 5545) |
| ICS import/export | `ical-generator` (export) + `ical.js` (import) |
| File I/O | `tauri-plugin-dialog` + `tauri-plugin-fs` |

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

## Where your data lives

A single SQLite file, `secondbrain.db`, in Tauri's app-data directory:

- macOS: `~/Library/Application Support/com.elliottjones.secondbrain/`

Migrations are versioned and idempotent (managed by `tauri-plugin-sql`); they run automatically on startup.

## Features

- **Today** — dashboard of today's schedule, due/overdue tasks & reminders, pinned + recent notes. ICS import/export buttons.
- **Calendar** — month / week / day views, event CRUD, drag-to-reschedule (month view, non-recurring events), RRULE recurrence, all-day + color-coded events. Todos with due dates appear as dashed chips.
- **Reminders** — due date + optional alert time, recurrence, priority, link to a to-do. Native OS notifications fire when due (polled once a minute while the app is open).
- **To-Do** — multiple lists, subtasks, priority, due dates, drag-to-reorder, and "Convert to event".
- **Notes** — markdown with live preview, pin, FTS5 full-text search.
- **Integration** — shared tagging and generic `links` (any item ↔ any item) across all four types; global search across everything.

## Standards / future sync

The schema is deliberately CalDAV-ready even though sync isn't built yet:

- UUID primary keys double as iCalendar `UID`s.
- Events store RFC 5545 fields directly (`summary`, `dtstart`, `rrule`, `exdates`, `status`, `categories`, …).
- Every syncable row has `created_at`, `updated_at`, and a `sequence` that increments on edit (mirrors iCalendar `SEQUENCE`).
- **Export to `.ics`** (Today → Export) proves the schema is standards-compliant — drag the file straight into Apple Calendar. Import reads events back, preserving UIDs.

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
  components/
    ui.tsx              # Modal, Button, priority helpers
    ItemMeta.tsx        # shared Tags + Links panels
    EventForm.tsx       # event create/edit
  views/                # Today, Calendar, Reminders, Todos, Notes, Search
src-tauri/
  src/lib.rs            # plugin wiring + migration registration (thin)
  migrations/001_init.sql
  capabilities/default.json  # plugin permissions
```

## Notes / current limitations

- Desktop notifications are **poll-based** (checked every 60s while the app is open) — the plugin has no cross-platform "schedule for later" API. Alerts won't fire while the app is closed.
- Drag-to-reschedule is day-granularity in month view and disabled for recurring series (dragging a single instance is ambiguous; edit the series, or use "Skip this day").
- No timezone handling beyond the machine's local zone (fine for single-user local use; revisit before CalDAV sync).
