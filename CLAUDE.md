# CLAUDE.md — Sekunda

Life-management desktop app (Calendar, Reminders, To-Do, Notes, People) + optional AI assistant. Multi-user accounts, data in the cloud so it follows you between devices; reads fall back to a local cache offline, writes fail loudly. Tauri v2 + React 19 + TypeScript + Vite + Tailwind, on a Cloudflare Worker + D1 + KV backend.

**Golden rule: update [README.md](README.md) in the same session as any change to features, architecture, data model, permissions, or the AI toolset.**

## Commands

```bash
npm run tauri dev      # native app (compiles Rust; first run slow)
npm run dev            # whole app in a browser — see Testing
npm run worker:dev     # local Worker + D1 (wrangler dev); tauri dev starts it too
npm run worker:migrate # apply D1 migrations locally (idempotent)
npx tsc --noEmit       # after every change — ALSO -p worker and -p packages/shared
npx vite build         # after every change
cd src-tauri && cargo check    # after touching Rust
npm run tauri build && open "src-tauri/target/release/bundle/macos/Sekunda.app"
```

Finish with `tsc` + `vite build` (+ `cargo check`), then the packaged build — some features (microphone) only work bundled. `noUnusedLocals` is on: no dead imports.

Data lives in **Cloudflare D1** behind the Worker in `worker/`, not on the device. There is no local database file and no SQLite engine in the client — see [`docs/cloud-migration-plan.md`](docs/cloud-migration-plan.md). Settings and secrets are still `localStorage`.

## Testing

Use the browser for anything the UI can show; E2E only for what needs the real runtime.

**Browser — `npm run dev` + a local Worker (`npm run worker:dev`).** `wrangler dev` runs D1 in Miniflare against `.wrangler/state`, so the client talks real HTTP + JSON to the same Worker code production runs. `npm run tauri dev` starts both.
- Apply migrations first: `npm run worker:migrate` (idempotent).
- Schema still can't drift — it's the same `worker/migrations/*.sql` the deployed Worker uses.
- It now proves **more** than the old sqlite-wasm path: the transport is the real one, so a bridge bug can't hide. What it can't prove is anything packaged-only (microphone).
- You need an account: register through the UI. Data persists in `.wrangler/state` until you delete it.
- `npx wrangler d1 execute secondbrain-dev --local --command "…"` inspects what a click wrote.

**E2E — the real app against a real Worker.**
```bash
npm run test:e2e:build   # tauri build --features wdio (slow; required first)
npm run test:e2e         # wdio run wdio.conf.ts → e2e/*.spec.ts
```
- The embedded WebDriver server is behind an **opt-in `wdio` cargo feature**, not `debug_assertions`, so ordinary `tauri dev` never opens an automation port. It must never ship in a release build.
- `wdio.conf.ts` targets the executable *inside* the bundle (`…/Contents/MacOS/second-brain` — the `[[bin]]` name in `Cargo.toml`, which macOS shows in the Dock for `tauri dev`); spawning the `.app` gives EACCES.
- Rebuild before running or you silently test a stale binary — the symptom is "WebDriver server did not become ready".
- Reserve for what only the runtime answers (the plugin's JSON bridge, packaged-only APIs).
- `tsconfig.json` includes only `src`, so `wdio.conf.ts` and `e2e/**` are **not** typechecked.

## Architecture (do not violate)

1. **Thin Rust.** `lib.rs` wires plugins and nothing else — no database, no migrations. All logic is TypeScript, so a browser/mobile build stays a packaging change.
2. **`src/db.ts` is the only module that talks to the API for domain data**, and `worker/src/db/` is the only place SQL is written. Views never call `lib/api.ts` directly.
3. **All event access goes through `src/lib/calendars.ts`**, which merges the built-in calendar with CalDAV ones and routes writes. Views and `ai.ts` must never call `db.ts` event helpers or the CalDAV client directly.
4. **Keep domain tables separate; connect via `links` + `item_tags`.**
5. **Schema is CalDAV/CardDAV-ready:** UUID PKs double as iCal/vCard UIDs; syncable rows carry `created_at`, `updated_at`, `sequence`. Preserve when adding fields.

## Traps (each of these has bitten us)

**Data**
- **Never edit an applied migration.** Add `worker/migrations/000N_*.sql` and apply with `npm run worker:migrate` (local) / `migrate:staging` / `migrate:production`. D1 tracks what it has applied; editing a file it already ran leaves environments silently divergent. No registration step — wrangler picks the directory up.
- **Notes FTS uses `trigram remove_diacritics 1`** (005): `unicode61` indexes a space-free CJK sentence as one token, and FTS5 accepts any codepoint >127 so the query "succeeds" with zero rows. Trigram can't answer queries under 3 chars (most Chinese words are 2), so `searchNotes` routes those to `LIKE`. Keep both paths; both must AND the terms.
- **Note images live in `note_images`, never inline in `notes.body`** (body holds `![alt](sbimg:<id>)`). A data URI there hits `listNotes` — `SELECT *` on every search keystroke — *and* the trigram index: measured, one 300KB image costs a 638KB index inline vs 331 bytes split out. Base64 `TEXT` through the plugin bridge is not the bottleneck people assume — 400KB round-trips intact in ~3ms write / ~1ms read (`e2e/noteImages.spec.ts`).
- **No foreign keys anywhere in this schema.** `PRAGMA foreign_keys = ON` in 001 applies to the *migration* connection, so `ON DELETE CASCADE` silently never fires. Delete children explicitly in `db.ts` (`deleteTodo` for subtasks, `deleteNote` for images).
- **NFC-normalize identity keys** (`normalizeKey`) — macOS IMEs emit NFD, SQLite compares byte-wise, `tags.name` is UNIQUE, so one visible tag becomes two rows.
- **Sort text client-side with `Intl.Collator`** — no `COLLATE UNICODE` without ICU; `NOCASE` folds ASCII only.

**Calendars**
- **Remote events are never stored in SQLite** — live fetch is the design, which is why CalDAV needed no migration. Offline caching is a separate project (`ctag`/`sync-token` + migration).
- **Remote events have no local row**, so tags/links/people don't apply. Don't fake one.
- **Two expansion paths on purpose:** local uses `rrule`, remote uses **ical.js** for the `TZID` + `VTIMEZONE` only it resolves. Unifying them breaks cross-timezone events.
- **Writes are ETag-guarded** (`If-Match`, `If-None-Match: *`). A 412 is a real conflict — surface it, never blind-retry.
- **Reads fail soft:** `getOccurrences` returns `{ occurrences, errors }`; a dead iCloud must never break the local calendar.
- **`searchEvents` is asymmetric on purpose** — local is SQLite so it searches all time; CalDAV has no keyword search at all, so remote can only be a windowed fetch matched client-side. Any caller MUST show the window (`SearchView`'s footer): outside it, results are *missing*, not absent. It returns one hit per **event**, not per occurrence — a daily standup expanded over a year is one thing the user is looking for — dated to the occurrence nearest now, never the series start.
- **Snap any search window to whole days.** `getRemoteOccurrences` caches on `calendarId|start|end`, so a window built from `new Date()` mints a fresh key on every keystroke and re-hits the network per character. Debounce too — a keystroke can now cost a CalDAV round-trip.
- **Writes preserve the source zone via `UnifiedEvent.tzid`.** `dtstart` is still an absolute instant; `tzid` is a *write-back hint only*, set in `toUnified` from `startDate.zone.tzid` (null for all-day/floating/UTC/local). `buildCalendarData` emits `DTSTART;TZID=` + the `VTIMEZONE` **only when the zone is registered in `ICAL.TimezoneService`** — reads register every VTIMEZONE they see, so a fetched event can round-trip; anything else falls back to UTC. **We ship no tz database, so events created in-app still write UTC and a new recurring timed series still drifts across DST.** Never "fix" that by dropping the `fromJSDate(d, true)` — `false` emits a floating time, which is worse. `EXDATE` must carry the same value type and zone as `DTSTART` or the skipped occurrence comes back.

**Platform**
- **External APIs go through `lib/httpFetch.ts`, never a direct `import { fetch } from "@tauri-apps/plugin-http"`.** Inside Tauri it resolves to the plugin (the webview's own fetch is blocked by CORS from `tauri://`, and the URL must be scoped in `capabilities/default.json`); in a browser the plugin's IPC command doesn't exist, so a static import compiles, ships, and throws on every call. It is resolved at runtime for that reason. The plugin was also doing duty as a CORS *bypass*, which the web build doesn't get: Open-Meteo and OpenAI send CORS headers so they work; **Yahoo and iCloud send none.** Stocks therefore route through the Worker's `/v1/quotes` proxy on web only (`stocks.ts` picks by `isTauri()` — desktop calls Yahoo directly rather than spending request quota on a problem browsers alone have). Connected calendars relay through the Worker's `/v1/dav` route on web only (`caldav/client.ts` picks by `isTauri()`; desktop still talks to Apple directly). **That relay sees the user's iCloud app-specific password and their calendar contents in plaintext** — TLS terminates at the Worker. It was accepted deliberately to make calendars work on the web; `worker/src/routes/dav.ts` records what keeps it tolerable (nothing stored, nothing logged, session required, iCloud-only, redirects never followed) and what hardening is still owed. **Never add a `console.log` of a request or response in that file** — observability is on, so the password would land in log retention.
- **Two rate limiters, and they are not interchangeable.** `auth_throttle` (migration 0002, `auth/throttle.ts`) counts *failures* against an account and locks it — durable, globally consistent, worth a D1 round-trip because it runs once per sign-in. `rateLimit.ts` counts *successes* on hot paths (`/v1/dav`, `/v1/quotes/*`) with Cloudflare's in-colo binding, because a D1 hop per relayed CalDAV call would be the dominant cost of the feature. The binding is **per-colo, not global**, and it must be repeated under every `[env.*]` block in `wrangler.toml` — wrangler does not inherit bindings into named environments, and a missing one throws at request time by design (failing open would silently un-limit the relay).
- **Anything that mails a token must answer identically for every address** — known, unknown, provider down, `RESEND_API_KEY` unset. `/auth/kdf` set the precedent with its decoy salt; `/auth/password/forgot` follows it. The trap is the *failure* modes: a distinct "email isn't configured" for real accounts leaks exactly what the flow exists to hide. Reset tokens ride in the URL **fragment**, never the query string, so they never reach a server log or a `Referer`.
- **Email confirmation is a hard login gate, and the gate is coupled to the mailer.** `/auth/login` refuses an unconfirmed account (correct password → `email_unverified` code, a *distinct* error so the client offers "resend" not "wrong password"), and `/auth/register` no longer issues tokens — it returns `{ verification_required: true }` and the client shows "check your inbox". Because a locked-out user can't reach an authed endpoint, resend is the **public** oracle-safe `/auth/email/verify/resend`, not the authed `/auth/email/verify/send`. Consequence: **an environment with no `RESEND_API_KEY` set can never sign anyone new in.** Don't "simplify" register back to auto-login — it reopens the gate. The `email_unverified` check must stay *after* the password check or it becomes an account-existence oracle.
- **A reset replaces credential material, it does not "change a password"** — the server never sees one, on this path least of all. The client derives a new key under a *new* salt; reusing the old salt would let a captured derived key be replayed. Using a token revokes every session, but **not** access tokens already issued: those are stateless 15-minute JWTs, so there is a bounded window. Documented, not accidental.
- **The web build's CSP is injected at build time by a Vite plugin, not written in `index.html`** — the dev server needs `eval` and a websocket that a shipped bundle must not allow, and `connect-src` has to name whichever `VITE_API_URL` the build targeted. Three directives are load-bearing: `'wasm-unsafe-eval'` (hash-wasm compiles argon2id at runtime — without it sign-in fails *inside the KDF* and reads as "wrong password"), `blob:` in `img-src` (note images can't carry a Bearer header on an `<img src>`), and `ipc: http://ipc.localhost` in `connect-src` (the same `dist/index.html` is what Tauri packages — omit these and every plugin call silently fails). `frame-ancestors` is absent because meta-delivered CSP ignores it. Verify with `npx vite build` and serving `dist/`, never with `npm run dev`.
- **A proxy route takes a symbol, never a URL** (`worker/src/routes/quotes.ts`). A `?url=` parameter would make it an SSRF tool and a free bandwidth relay. It also requires a session, fixes the upstream paths, allowlists the query parameters, and returns only JSON with upstream headers dropped so the origin can't be handed cookies. Any future proxy copies that shape.
- **A Worker deploy takes ~a minute to reach every edge location.** Verifying immediately after `wrangler deploy` samples a mix of old and new versions — it looks like a config that didn't apply, or worse, an intermittent bug. Re-test after a minute before believing a post-deploy failure.
- **`reqwest` drops `Authorization` on cross-host redirects** and iCloud always redirects to a per-user shard, so `davRequest` sets `maxRedirections: 0` and re-attaches auth per hop. Simplifying it gives a 401 that looks like bad credentials.
- **`window.prompt()` is a silent no-op in WKWebView.** `confirm`/`alert` work.
- **Mic needs `NSMicrophoneUsageDescription`** in `Info.plist` — packaged builds only.
- **New plugin = 3 steps:** crate in `Cargo.toml`, `.plugin()` in `lib.rs`, permission in `capabilities/default.json`.

**Today page**
- **A widget is one file exporting one `TodayWidget`** (`components/today/`), registered in `registry.ts` and nowhere else; it fetches its own data and renders its own card.
- **Every widget renders inside `CardBoundary`** — otherwise one card's throw blanks the page.
- **Shared reads go through `dayData.ts`**, whose promise cache stops five widgets making the same query. Its revision counter is module-scoped and monotonic on purpose: a per-mount `useState(0)` collides with a cache left at revision 0 and serves stale rows.
- **`useAsync` keeps the previous value during a reload** — blanking it flashes a skeleton on every checkbox tick. Same reason there's no Suspense.
- **Rules two widgets share live in `derive.ts`** (day-scoping, overdue, birthdays) — the card shows them and the summary describes them, so two copies drift.
- **Order/visibility live in `settings.todayLayout`, read via `mergeTodayLayout`** — stored ids are a *preference*, not an inventory, so new widgets must be appended and removed ones dropped. Renaming an id resets that card's position for everyone.
- **The summary cache is keyed by day (`lang|date`), not by its fact signature** — the entry an aged-out day has to be compared against is "the briefing this day already has", which a signature-keyed cache can't find. The entry carries `sig` (exact match = always reusable) and `at` (a changed day reuses it while inside `summaryMaxAgeMs()`, default 6h, off in Settings). Age is only checked when the facts change or the card mounts — no timer, so nothing is billed while nobody's looking. Changing the entry shape means bumping `CACHE_KEY`.
- **Hiding a card stops its fetch, not just its render** (the summary is billed, the forecast is a free service). Keep fetches inside widgets; hoisting one to `TodayView` makes hidden cards pay again.

**UI**
- **No drag-and-drop. HTML5 drag does not work in this WKWebView** — confirmed broken in all four places it was used; the `dataTransfer.setData` + `-webkit-user-drag` + `user-select: none` fix changed nothing. Reordering is ▲/▼ buttons; rescheduling is edit-the-event. Don't add `draggable` back: it compiles, looks right, does nothing.
- **Don't add a `key={version}` that bumps on mutations** — it remounts the view and wipes in-progress edits (this broke Notes typing). The old `resetNonce` escape hatch is gone with the demo seeder; don't reintroduce one.
- **The note editor debounces writes (400ms)**, flushing on unmount. Don't revert to save-per-keystroke.
- **`ReactMarkdown` needs BOTH `components={{ img: NoteImage }}` and `urlTransform={noteUrlTransform}`** wherever note bodies render — `defaultUrlTransform` blanks any protocol outside http/https/mailto/xmpp/irc, so an `sbimg:` ref arrives as `src=""` and draws a broken-image box that reads as a load failure. Keep the override narrow (img `src` only) so `javascript:` is still killed.
- **A YouTube video can never be an inline `<iframe>` here.** YouTube's embed needs a valid HTTP `Referer`; a packaged Tauri app serves the UI from `tauri://localhost` and has none, so every embed returns **"Error 153: Video player configuration error"** ([tauri#14422](https://github.com/tauri-apps/tauri/issues/14422) — `referrerpolicy`, `?origin=`, `withGlobalTauri` all tried, none work; the only cure, `tauri-plugin-localhost`, kills IPC). An in-app webview window doesn't rescue it either — measured: `/embed/` as that window's *top-level* document still returned 153, so the referrer check isn't about being framed. `YouTubeEmbed` therefore renders a thumbnail that opens the watch page in the **user's own browser** (`openUrl`, the opener plugin already wired up). It plays inline perfectly in `npm run dev` — that's the trap. Never "simplify" it back to an iframe without testing the packaged build.
- **YouTube embeds are a bare URL in the body, never raw HTML.** `rehype-raw` stays out: note bodies can be written by the assistant, so widening the renderer to arbitrary HTML for one feature is the wrong trade. A bare YouTube link (remark-gfm autolinks it, so link text === href) becomes a video card via the `a: NoteLink` override; `[labelled](url)` stays a link. `normalizeEmbeds` rewrites a pasted `<iframe>` **in the preview string only**, never in what's stored — react-markdown drops raw HTML silently, so without it the video just vanishes. The card's wrapper is a `<span class="block">`; a `<div>` inside the `<p>` react-markdown emits is invalid nesting.
- **Toolbar/paste inserts go in through `insertLine`**, which adds a newline on either side only when there isn't one — hard-coding `\n\n` leaves blank lines all through a note.
- **Image inserts drop a placeholder token first, then swap it** — encode + write are async while the user types, so resolving the caret after the await misplaces the image. The swap matches `(token)` with parens: bare `pending-1` also matches inside `pending-11`.
- **Icons: `lucide-react` only, no emoji.**
- **Deep-linking into a view = `NavTarget` key + a prop consumed on mount** (`navigate` in `App.tsx`). Todos/Reminders/People guard with an `opened` ref so closing the detail can't re-open it.
- **An event target needs `NavTarget.eventStart`, not just `eventId`.** `CalendarView` resolves a target out of the occurrences loaded for the *visible* window, so an id alone silently opens nothing whenever the event is outside it — invisible from Today (always same-day), routine from search. `eventStart` seeds the cursor's month and picks the right instance of a recurring series.

**Assistant surfaces**
- **The turn/voice lifecycle lives in `useAssistantChat`, not a component** — two surfaces run a conversation (page, popup) and `deliver`/the mic lifecycle/the speech hold-back are too delicate to exist twice.
- **`useAssistantChat` is called ONCE, in `App.tsx`**, and the object passed to whichever surface is on screen. Per-surface instances aborted their own turn on unmount, and `deliver` **drops the cancelled user message** — so "Open in Assistant" straight after sending (the popup unmounts on that page) deleted what you'd just typed and read as the chat resetting. Anything that unmounts a surface mid-turn has this bug; keep the hook above them. It also makes the window-level hold-to-talk listener structurally single-instance instead of relying on the surfaces never overlapping.
- **The conversation itself lives in `App.tsx`, not `AssistantView`** — item cards navigate away and unmount the view, which wiped the chat on every card click. The popup also renders in `App.tsx`, outside `<main>`, so navigation doesn't close it.
- **`spaceEnabled` is computed in `App`** (`configured && (on the assistant page || popup open)`) — the surfaces no longer own it.
- **Closing the popup doesn't unmount it**, so unmount cleanup never runs; `cancelInput()` on close is what stops a hot mic behind a closed window. Any new "dismissed but mounted" surface needs it.
- **Hold-Space is gated on `spaceEnabled`** — always-on, holding Space anywhere starts an invisible recording.
- **The calendar's bottom bar keeps its right side clear** (`pr-20`) — the popup's button owns every page's bottom-right corner.

## i18n (`src/lib/i18n.ts`)

- **Every user-facing string goes through `t()`.** English (`src/locales/en/app.json`) is the source of truth — `@types/i18next.d.ts` derives the key union from it, so a missing key is a compile error and both catalogs must stay in sync.
- **Model-facing text stays English:** `SYSTEM_PROMPT`, `TOOLS` descriptions, tool `{ error }` results. `ai.ts` imports the *unlocalized* date-fns `format` for the same reason.
- **`t` gets shadowed** by rows named `t` (`todos.map((t) => …)`) — alias the hook: `const { t: tr } = useTranslation()`.
- **Use `lib/format.ts` helpers, never raw date-fns patterns** — they go through `Intl.DateTimeFormat` because `"MMM d"` gives `7月 20` in Chinese (correct: `7月20日`) and `"h a"` gives `1 下午` (correct: `下午1時`). date-fns still decides `weekStartsOn`. The locale lives in `format.ts`; don't thread one through call sites.
- **`<html lang>` is set at runtime** — CJK is Han-unified, so a wrong `lang` shows a Traditional reader Japanese glyphs, and it drives the default TTS voice.
- **Adding a language:** catalog in `src/locales/<code>/`, entry in `LANGUAGES`, case in `matchSystemLanguage`, locale in `DATE_LOCALES`.

## AI assistant (`src/lib/ai.ts`)

- **Tool-calling, not context-stuffing** — agentic loop capped at `MAX_TOOL_ROUNDS`. Read tools are filtered + paginated (`limit` default 25 / max 100, returning `total` + `truncated`); push filters into SQL/FTS.
- **Every text search matches TERMS, never the whole query as one substring** — `%lunch with Alex meeting%` finds nothing when the event is "Lunch with Alex", and the assistant then says it doesn't exist. `matchQuery` ANDs the terms, then falls back to ranked partial matches with `partial_match` set so the model confirms before acting (this protects deletes). `matchQuery`, `anyTermClause` and `queryTerms` all live in **`db.ts`** — the global search bar needs identical ranking, and the one thing two copies would drift on is the phrasing bug they exist to prevent. SQL prefilters with `anyTermClause`, JS ranks.
- **`search_events` defaults its window to `startOfDay(now)`** — the current instant hid a 12:30 lunch at 2pm. It won't look back past today; older items need an explicit `start`.
- **Write tools partial-merge** (`"field" in args` distinguishes clear-to-null from leave-alone) and reuse `db.ts` upserts so `sequence`/timestamps stay right.
- **Deletion is permanent** with no UI confirmation — the prompt makes the model confirm. Adding a dialog is a deliberate change (update README).
- **Calendar tools are multi-calendar:** `search_events` merges local + remote and returns `calendar_id`; `create_event` takes a calendar *name*, else `defaultCalendarId()`; update/delete/`get_item` take an optional `calendar_id` and otherwise scan by UID.
- **The model doesn't believe the date unless you make it.** `dateContext` sits at the **top** of the prompt and repeats after the last user turn; buried at the bottom it was obeyed for `create_event` and ignored for arithmetic. Anything it would otherwise *compute* from a date is computed in TS (`birthdayFacts` returns `age`/`next_birthday`).
- **The model must emit local-offset ISO (`+08:00`), never `Z`** — a `Z` saves events at the wrong hour.
- **Reply style is prompt-governed, not UI-governed.** The "How to answer" block keeps replies to one or two sentences of speakable prose with no tables/lists/`**Time:**` labels, because voice reads them aloud; `temperature` is 0.6 for the same reason. Fix tone regressions there, not in `AssistantView`.
- **`show_items` must run BEFORE the reply, as its own round** — a message carrying `tool_calls` effectively never also carries content, so asking for cards "in the same turn" is unsatisfiable and the model just narrates intent. Keep prompt and tool description matching round N = `show_items`, N+1 = prose.
- **Prompt wording alone doesn't make it reliable** — prose and tool calls compete for the same step. `recoverItemCards` is the backstop: on `sawItems && !showedItems` it re-asks with *only* that schema at `temperature: 0`, requesting **refs only, never regenerating the reply**, swallowing its own errors. Don't "simplify" it into a normal extra round.
- **Cards come from `show_items`, nothing else.** `emitItems` is a callback, not a return value, so refs still reach the UI if a later round throws. Refs are **identity only** (`ItemRef`); `ItemCard.tsx` loads each row itself, so a card never shows what the model *said*.
- **Shown cards become follow-up context** — `askAssistant` injects a `shownItemsNote` (id/calendar_id/occurrence_start) after each turn that showed cards, which is what lets "delete it" resolve without a re-search. Labels are best-effort **local** lookups; no network on this path.
- **Key event cards on `id + occurrenceStart`** — one recurring id has many `start`s; keying on id alone collapses them into one card.
- **`show_items` resolves the occurrence; don't trust the model to pass `occurrence_start`** — omitting it made a weekday standup show the day the series *began*. `fillOccurrenceStarts` fills it from start-of-today.
- **Recurring reminders have the same trap, fixed card-side** — they store the series' base time, so a daily 8am reminder rendered yesterday flagged overdue. `ItemCard` resolves via `nextOccurrenceFrom` and **never** flags a recurring reminder overdue. Elsewhere reminder rrule is display-only.
- **The prompt tells the model to preserve `sbimg:` refs verbatim** — an `update_note` that "tidies" the markdown orphans the image for good.
- **Adding a tool:** `TOOLS` entry + `executeTool` case + `statusFor` string.
- Settings live in `localStorage` (`settings.ts`), not the database, so "clear all data" doesn't wipe the API key or calendar account. **They are keyed per signed-in account** (`secondbrain.settings.<userId>`) — one shared bucket meant the next person to register on a device inherited the previous user's OpenAI key and iCloud password. Signed out, reads go to an `anon` bucket. This is isolation, not secrecy: it is still plaintext localStorage.

## Weather (`src/lib/weather.ts`)

- **Open-Meteo, because it needs no key and no account** — don't swap in a provider requiring registration. Attribution (CC-BY) is in Settings + README.
- **Never stored in SQLite** — fetched live, cached in `localStorage` for 30 min.
- **`current` only describes now**, so feels-like/humidity/wind/AQI are today-only; other days fall back to daily maxes and skip air quality. Don't render a `current` field on another day.
- **Any change to `DayWeather` must bump `CACHE_KEY`** — the cache outlives the code that wrote it, and adding `hours` without bumping shipped a `TypeError`. `readCache` also drops entries failing `isCurrentShape`.
- **Air quality is a second endpoint** (`air-quality-api.open-meteo.com`, own capability entry), fetched via `Promise.all` and failing independently — no AQI must never mean no weather card.
- **Bound the day range client-side** (`isForecastable`, ~90 back / 14 ahead) — out of range the API answers `200` with `{ error: true }`, so it looks like success.
- **`getDayWeather` never throws; `searchPlaces` does** — a silent empty search box is indistinguishable from "no such place".
- **Use local `yyyy-MM-dd`, never `toISOString().slice(0,10)`** — that shifts the day westward.
- **The AI day summary waits on the forecast** (`weatherSettled`), or the summary changes signature and pays twice. Condition text for the model is English (`englishCondition`).

## Voice (`src/lib/voice.ts`)

- Pure I/O layer around `askAssistant()` — don't couple it to agent logic. Push-to-talk only.
- **Rule (no setting):** spoke → speak the reply; typed → text only. `deliver(text, spoken)` carries this.
- **TTS must set `utterance.lang` and pick a voice explicitly** — an unset `lang` inherits `<html lang>`, so a Chinese reply on an English voice is *silent*, a failure with no error. Normalize `_`→`-` (macOS reports `zh_TW`) and wait for `voiceschanged` (WebKit returns `[]` first call).
- **Whisper gets a `prompt`, never a `language`** — `language` forces one and breaks bilingual speech.
- **Two ways to record, one lifecycle:** mic button toggles `startMic`/`stopMic`; Space does the same, skipped when an input/button/link is focused. `startingRef`/`stopPendingRef` guard the release-before-mic-opened race. Don't collapse `start`/`stop` into one `recording` toggle; the state is stale during that race.

## Layout

```
src/
  db.ts        # ONLY module calling the data API   types.ts  # + UnifiedEvent
  locales/     # en, zh-TW catalogs               @types/   # typed t() keys
  lib/  i18n · format · calendars · recurrence · ics · ai · voice · weather ·
        images · notifications · settings · api · cache · auth · authStore · kdf
        caldav/  client · discovery · events · ical    # talks to iCloud directly, not the Worker
  components/  ui · Avatar · ItemMeta · ItemCard · EventForm · MarkdownToolbar · NoteImage ·
        YouTubeEmbed
        today/   registry · types · CardShell · CardBoundary · useAsync · dayData ·
                 derive · <Name>Widget    # one file per Today card
        assistant/  useAssistantChat · MessageList · Composer · AssistantPopup
  views/       Today · Calendar · Reminders · Todos · Notes · People · Assistant · Settings · Search
e2e/           # WebDriver specs (real app only; not in tsconfig)
packages/shared/  # zod schemas + inferred types, matchQuery ranking, normalizeKey,
                  # DATA_TABLES. Imported by BOTH sides; no Cloudflare/Tauri imports.
worker/
  src/index.ts               # Hono app          authorize.ts  # the ONE access check
  src/rateLimit.ts           # per-user caps on the proxy routes (in-colo, not D1)
  src/auth/                  # crypto · tokens · throttle (failed logins) · email
  src/middleware/            # cors · auth · securityHeaders
  src/routes/                # one file per area (auth · spaces · health · quotes · dav)
  src/db/                    # the ONLY place SQL is written; every query takes space_id
                             #   (+ recovery.ts, account.ts — identity, keyed by user)
  migrations/000N_*.sql      # 0001 init (squashed + tenancy) · 0002 auth throttle ·
                             #   0003 image blob_key · 0004 reset/confirm tokens
  wrangler.toml              # D1 + KV bindings per environment
src-tauri/
  src/lib.rs                 # plugin wiring ONLY — no database, no migrations
  capabilities/default.json  # http scope: the Worker + api.openai.com + *.icloud.com +
                             #   *.open-meteo.com + localhost/127.0.0.1 (Ollama, dev
                             #   Worker). NO blanket `http://*` — it was removed in M5;
                             #   a plaintext-HTTP host now needs an explicit entry.
```

## Conventions & don'ts

- TypeScript function components, Tailwind utilities (no CSS files beyond `index.css`). SQLite booleans are `0/1`.
- Reuse `db.ts` helpers and the shared `Modal`/`Button`/`PriorityFlag`/`TagEditor`/`LinksPanel` primitives. Match surrounding style and comment density.
- Don't add Xcode/Swift or any Apple-only API — iCloud is plain CalDAV over HTTP, which keeps it portable.
- Don't hand-roll iCalendar parsing, recurrence, vCard, or WebDAV XML — use the libraries/helpers.
- Don't add cloud/account features beyond user-supplied CalDAV credentials (no backend, no hosting).
