# CLAUDE.md — Second Brain

Local-first life-management desktop app (Calendar, Reminders, To-Do, Notes, People) + optional AI assistant. Single user, offline, no accounts. Tauri v2 + React 19 + TypeScript + Vite + Tailwind + SQLite.

**Golden rule: update [README.md](README.md) in the same session as any change to features, architecture, data model, permissions, or the AI toolset.** "Code changed but README didn't" = incomplete.

## Commands

```bash
npm run tauri dev      # native app (compiles Rust; first run slow)
npm run dev            # frontend only in a browser (DB calls no-op outside Tauri)
npx tsc --noEmit       # after every change
npx vite build         # after every change
cd src-tauri && cargo check    # after touching Rust
npm run tauri build && open "src-tauri/target/release/bundle/macos/Second Brain.app"
```

Finish with `tsc` + `vite build` (+ `cargo check`), then the packaged build — some features (microphone) only work bundled. `noUnusedLocals` is on: no dead imports.

Runtime DB: `~/Library/Application Support/com.elliottjones.secondbrain/secondbrain.db`.

## Architecture (do not violate)

1. **Thin Rust.** `lib.rs` only wires plugins + registers migrations. All logic is TypeScript, so a browser/Windows build stays a packaging change.
2. **`src/db.ts` is the only module that touches SQLite.** (`ai.ts` runs some filtered read SQL by design — keep new query logic there or in `db.ts`, never in views.)
3. **All event access goes through `src/lib/calendars.ts`** — it merges the SQLite calendar with CalDAV ones and routes writes. Views and `ai.ts` must never call `db.ts` event helpers or the CalDAV client directly.
4. **Keep domain tables separate; connect via `links` + `item_tags`.** Don't collapse them into one generic table.
5. **Schema is CalDAV/CardDAV-ready:** UUID PKs double as iCal/vCard UIDs; syncable rows carry `created_at`, `updated_at`, `sequence`. Preserve when adding fields.

## Traps (each of these has bitten us)

**Data**
- **Never edit an applied migration** — sqlx checksums them. Add `00N_*.sql`, register in `lib.rs`, and test 001→N against a temp DB with `sqlite3` first.
- **Notes FTS uses `trigram remove_diacritics 1`** (005), not `unicode61` — the default indexes a whole space-free CJK sentence as ONE token, and the `LIKE` fallback never fired because FTS5 accepts any codepoint >127 and "succeeds" with zero rows. **Trigram can't answer queries under 3 chars** (most Chinese words are 2), so `searchNotes` routes those to `LIKE`. Keep both paths and keep their multi-term semantics identical (both AND the terms).
- **NFC-normalize identity keys** (`normalizeKey`). macOS IMEs emit NFD, SQLite compares byte-wise, `tags.name` is UNIQUE — otherwise one visible tag becomes two rows.
- **Sort text client-side with `Intl.Collator`.** SQLite has no `COLLATE UNICODE` without ICU; `NOCASE` folds ASCII only.

**Calendars**
- **Remote events are never stored in SQLite** — live fetch is the design, which is why CalDAV needed no migration. Don't add a remote-events table; offline caching is a separate project (`ctag`/`sync-token` + migration).
- **Remote events have no local row**, so tags/links/people don't apply. Don't fake one.
- **Two expansion paths on purpose:** local events use `rrule`; remote use **ical.js** because they carry `TZID` + `VTIMEZONE` that only ical.js resolves. Unifying them silently breaks cross-timezone events.
- **Writes are ETag-guarded** (`If-Match`, `If-None-Match: *`). A 412 is a real conflict — surface it, never blind-retry.
- **Reads fail soft:** `getOccurrences` returns `{ occurrences, errors }`. A dead iCloud must never break the local calendar.
- **Writes emit UTC `DTSTART`, not `TZID`** (v1). Consequence: re-saving a recurring Apple event drifts an hour across DST. Fixing it means emitting `VTIMEZONE` too — dropping the UTC conversion alone produces floating times, which is worse.

**Platform**
- **External APIs must use `@tauri-apps/plugin-http`'s `fetch`**, not the webview's (CORS from `tauri://`), and the URL must be scoped in `capabilities/default.json`. Parsing the response in JS is fine.
- **`reqwest` drops `Authorization` on cross-host redirects** and iCloud always redirects to a per-user shard, so `davRequest` sets `maxRedirections: 0` and re-attaches auth per hop. Simplifying that gives a 401 that looks like bad credentials.
- **`window.prompt()` is a silent no-op in WKWebView.** `confirm`/`alert` work.
- **Mic needs `NSMicrophoneUsageDescription`** in `Info.plist` — packaged builds only.
- **New plugin = 3 steps:** crate in `Cargo.toml`, `.plugin()` in `lib.rs`, permission in `capabilities/default.json`.

**UI**
- **Don't add a `key={version}` that bumps on mutations** — it remounts the view and wipes in-progress edits (this broke Notes typing). `resetNonce` exists only for demo resets.
- **The note editor debounces writes (400ms)**, flushing on unmount. Don't revert to save-per-keystroke.
- **Icons: `lucide-react` only, no emoji.**
- **The assistant conversation lives in `App.tsx`, not `AssistantView`.** Item cards navigate away, which unmounts the view — owning `messages` locally silently wiped the chat on every card click. `resetNonce` still remounts the view, so a demo reset clears `chat` explicitly.
- **Deep-linking into a view = `NavTarget` key + a prop the view consumes on mount** (`navigate` in `App.tsx`). Every type supports it; Todos/Reminders/People guard with an `opened` ref so closing the detail can't re-open it.

## i18n (`src/lib/i18n.ts`)

- **Every user-facing string goes through `t()`.** English (`src/locales/en/app.json`) is the source of truth — `src/@types/i18next.d.ts` derives the key union from it, so a missing key is a compile error and both catalogs must stay in sync.
- **Model-facing text stays English:** `SYSTEM_PROMPT`, `TOOLS` descriptions, tool `{ error }` results. `ai.ts` imports the *unlocalized* date-fns `format` for the same reason.
- **`t` gets shadowed** by rows named `t` (`todos.map((t) => …)`). Alias the hook there: `const { t: tr } = useTranslation()`. `tsc` catches it.
- **Use the `lib/format.ts` helpers, never raw date-fns patterns.** They go through `Intl.DateTimeFormat` because `"MMM d"` renders `7月 20` in Chinese (correct: `7月20日`) and `"h a"` gives `1 下午` (correct: `下午1時`). date-fns still decides `weekStartsOn`. The active locale lives in `format.ts`, so helpers take one arg — don't thread a locale through call sites.
- **`<html lang>` is set at runtime.** CJK codepoints are Han-unified; a wrong `lang` shows a Traditional reader Japanese glyphs, and it drives the default TTS voice.
- **Adding a language:** catalog in `src/locales/<code>/`, entry in `LANGUAGES`, case in `matchSystemLanguage`, locale in `DATE_LOCALES`.

## AI assistant (`src/lib/ai.ts`)

- **Tool-calling, not context-stuffing** — agentic loop capped at `MAX_TOOL_ROUNDS`.
- **Read tools are filtered + paginated** (`limit` default 25 / max 100, returning `total` + `truncated`). Push filters into SQL/FTS.
- **Every text search matches TERMS, never the whole query as one substring.** `%lunch with Alex meeting%` matches nothing when the event is "Lunch with Alex" — the user's phrasing is never the stored title word-for-word, and the assistant then reports the item doesn't exist. `matchQuery` ANDs the terms and, if that finds nothing, falls back to ranked partial matches with `partial_match` set so the model confirms before acting (this is what protects deletes). `queryTerms` is shared with `db.ts` so all searches agree. SQL tools prefilter with `anyTermClause` — SQL still narrows, JS ranks.
- **`search_events` defaults its window to `startOfDay(now)`, not `now`.** Defaulting to the current instant hid everything earlier the same day, so a 12:30 lunch became invisible at 2pm. The window still doesn't look back past today — finding older items needs an explicit `start`.
- **Write tools partial-merge** (`"field" in args` distinguishes clear-to-null from leave-alone) and reuse `db.ts` upserts so `sequence`/timestamps stay right.
- **Deletion is permanent** and there's no UI confirmation — the prompt makes the model confirm first. Adding a dialog is a deliberate change (update README).
- **Calendar tools are multi-calendar:** `search_events` merges local + remote and returns `calendar_id`; `create_event` takes a calendar *name*, else `defaultCalendarId()`; update/delete/`get_item` take an optional `calendar_id` and otherwise scan by UID.
- **The model doesn't believe the date unless you make it.** `dateContext` sits at the **top** of the system prompt and is repeated as a system message after the last user turn. Buried at the bottom and worded only as a scheduling rule, it was obeyed for `create_event` and ignored for arithmetic — asked a contact born in 1986's age, gpt-4o-mini answered from its training cutoff ("36"). Anything the model would otherwise *compute* from a date gets computed in TS instead: `birthdayFacts` returns `age`/`next_birthday` in the person tool results (`ageFromBirthday`/`nextBirthday` in `format.ts`, locale-free so `ai.ts` can import them).
- **The model must emit local-offset ISO (`+08:00`), never `Z`** — `ai.ts` injects the current local time + timezone for this. A `Z` saves events at the wrong hour.
- **Reply style is prompt-governed, not UI-governed.** The "How to answer" block in `SYSTEM_PROMPT` is what keeps replies to one or two sentences of speakable prose with no tables/lists/`**Time:**` labels — because the voice feature reads them aloud. `temperature` is 0.6 for the same reason (0.2 made the prose stiff). Tone regressions are fixed there, not in `AssistantView`.
- **`show_items` must be told to run BEFORE the reply, as its own round.** An assistant message carrying `tool_calls` effectively never also carries user-facing `content`, so asking the model to show items "in the same turn as your answer" is unsatisfiable — it writes the prose and narrates the intent instead ("Let me show you the details."), and no cards appear. The agentic loop already expects round N = `show_items`, round N+1 = prose; keep the prompt and the tool description matching that.
- **Prompt wording alone doesn't make `show_items` reliable** — writing prose and calling a tool compete for the same step, so the model skips it perhaps half the time. `recoverItemCards` is the backstop: when a turn ends with `sawItems && !showedItems`, it re-asks with *only* the `show_items` schema at `temperature: 0`. It requests **refs only and never regenerates the reply**, so it can't degrade prose, and it swallows its own errors — cards must never cost a good answer. Don't "simplify" it into a normal extra round.
- **Cards come from `show_items`, nothing else.** The model explicitly lists the items it's discussing; `executeTool` takes an `emitItems` callback that only that tool uses, surfacing refs through `AskOptions.onItems`. It's a callback, not a return value, so refs still reach the UI if a later round throws. Refs are **identity only** (`ItemRef`) — `ItemCard.tsx` loads each row itself, so a card never shows what the model *said* about an item.
- **Shown cards become follow-up context.** `ChatMessage.items` is stripped from what the model sees, but `askAssistant` injects a `shownItemsNote` system message after each assistant turn that showed cards, listing each item's id/calendar_id/occurrence_start. That's what lets "delete it" / "the lunch one" resolve without a re-search. Labels are best-effort **local** lookups (`getItemLabel`) — deliberately no network on this per-turn path; a remote event shows "(untitled)" but still carries the identity the model acts on.
- **Key event cards on `id + occurrenceStart`.** A recurring series returns one id with many `start`s; keying on id alone collapses every occurrence into one card.
- **`show_items` resolves the occurrence for recurring events; don't trust the model to pass `occurrence_start`.** Omitting it made the card fall back to the series' stored `dtstart` (a weekday standup showed the day the series *began*, not today). `fillOccurrenceStarts` fills the upcoming occurrence from start-of-today (local via rrule, remote via one shared ical.js fetch). The card's `occurrenceStart ?? ev.dtstart` fallback is now only a last resort.
- **Recurring reminders have the same trap, fixed card-side.** Reminders store the series' base time and nothing in the app expanded it, so a daily 8am reminder rendered yesterday's date flagged overdue. `ItemCard` resolves the current occurrence via `nextOccurrenceFrom` (reminders are local, so plain rrule is right) and **never** flags a recurring reminder overdue — it recurs by design. Reminder rrule is otherwise display-only (`describeRrule`); there's still no reminder occurrence expansion elsewhere (SearchView/RemindersView show the base date).
- **Adding a tool:** `TOOLS` entry + `executeTool` case + `statusFor` string.
- Settings live in `localStorage` (`settings.ts`), not SQLite, so a demo reset doesn't wipe the API key or calendar account.

## Weather (`src/lib/weather.ts`)

- **Open-Meteo, chosen because it needs no key and no account.** Don't swap in a provider that requires registration — "nothing to sign up for" is the constraint, not an accident. Attribution (CC-BY) is in Settings + README.
- **Never stored in SQLite**, same rule as remote calendar events: fetched live, cached in `localStorage` for 30 min. A forecast is stale within the hour, so persisting it just means showing yesterday's weather confidently.
- **Bound the day range client-side** (`isForecastable`, ~90 back / 14 ahead). Out of range, the API answers `200` with `{ error: true, reason }` — not an HTTP error — so a request outside the window is a wasted round trip that also *looks* like success.
- **`getDayWeather` never throws**; `searchPlaces` does. The tile is an enhancement on a page that works without it, but a search box that silently returns nothing is indistinguishable from "no such place".
- **Use local `yyyy-MM-dd`, never `toISOString().slice(0,10)`** — that shifts the day westward and asks for the wrong date.
- **The AI day summary waits on the forecast** (`weatherSettled`). Letting weather land after the briefing was written changes the summary's signature and pays for a second one. Condition text for the model is English (`englishCondition`), like everything else in `ai.ts`.

## Voice (`src/lib/voice.ts`)

- Pure I/O layer around `askAssistant()` — don't couple it to agent logic. Push-to-talk only.
- **Rule (no setting):** spoke → speak the reply; typed → text only. `deliver(text, spoken)` carries this.
- **TTS must set `utterance.lang` and pick a voice explicitly.** An unset `lang` inherits `<html lang>`, so a Chinese reply on an English voice is *silent* — a failure with no error. Normalize `_`→`-` (macOS reports `zh_TW`) and wait for `voiceschanged` (WebKit returns `[]` first call).
- **Whisper gets a `prompt`, never a `language`** — `language` forces one and breaks bilingual speech ("提醒我 3pm 開會").
- **Two ways to record, one lifecycle (`AssistantView`):** the mic button toggles `startMic`/`stopMic`; holding Space does the same (keydown→start, keyup→stop), skipped when an input/button/link is focused so Space still types/activates there. `startingRef`/`stopPendingRef` guard the release-before-mic-opened race — a tap that ends before `startRecording()` resolves discards the recording instead of leaving one running with no way to stop it. Don't collapse `start`/`stop` back into a single `recording`-state toggle; the state is stale during that race.

## Layout

```
src/
  db.ts        # ONLY module touching SQLite      types.ts  # + UnifiedEvent
  locales/     # en, zh-TW catalogs               @types/   # typed t() keys
  lib/  i18n · format · calendars · recurrence · ics · ai · voice · weather · notifications · settings · demo
        caldav/  client · discovery · events · ical    # network client, not SQLite
  components/  ui · Avatar · ItemMeta · ItemCard · EventForm
  views/       Today · Calendar · Reminders · Todos · Notes · People · Assistant · Settings · Search
src-tauri/
  src/lib.rs                 # plugin wiring + migrations (keep thin)
  migrations/00N_*.sql       # 001 init · 002 lists · 003 people · 004 custom fields · 005 FTS trigram
  capabilities/default.json  # http scope: api.openai.com + *.icloud.com + *.open-meteo.com + localhost (Ollama)
```

## Conventions & don'ts

- TypeScript function components, Tailwind utilities (no CSS files beyond `index.css`). SQLite booleans are `0/1`.
- Reuse `db.ts` helpers and the shared `Modal`/`Button`/`PriorityFlag`/`TagEditor`/`LinksPanel` primitives. Match surrounding style and comment density.
- Don't add Xcode/Swift or any Apple-only API — iCloud is plain CalDAV over HTTP, which keeps it portable.
- Don't hand-roll iCalendar parsing, recurrence, vCard, or WebDAV XML — use the libraries/helpers.
- Don't add cloud/account features beyond user-supplied CalDAV credentials (no backend, no hosting).
