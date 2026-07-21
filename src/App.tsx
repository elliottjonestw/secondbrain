import { useEffect, useRef, useState } from "react";
import { Home, Calendar, Bell, ListChecks, StickyNote, Users, Search, Brain, Sparkles, Settings as SettingsIcon, LucideIcon } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import TodayView from "./views/TodayView";
import CalendarView from "./views/CalendarView";
import RemindersView from "./views/RemindersView";
import TodosView from "./views/TodosView";
import NotesView from "./views/NotesView";
import PeopleView from "./views/PeopleView";
import SearchView from "./views/SearchView";
import AssistantView from "./views/AssistantView";
import AssistantPopup from "./components/assistant/AssistantPopup";
import type { UiMessage } from "./components/assistant/useAssistantChat";
import SettingsView from "./views/SettingsView";
import type { NavTarget } from "./types";
import { startReminderPoller, resetNotificationState } from "./lib/notifications";
import { isAssistantConfigured } from "./lib/settings";
import { db } from "./db";
import { resetAndSeedDemo } from "./lib/demo";
import { Modal, Button } from "./components/ui";

type View = "today" | "calendar" | "reminders" | "todos" | "notes" | "people" | "assistant" | "search" | "settings";

// Secret keystroke: hold Shift + 8 + 9 together anywhere in the app to open the
// "load demo data" prompt. Keys are matched by physical code so it works
// regardless of what Shift+8/9 types on the user's layout.

type NavId = Exclude<View, "search" | "settings">;

const NAV: { id: NavId; icon: LucideIcon }[] = [
  { id: "today", icon: Home },
  { id: "calendar", icon: Calendar },
  { id: "reminders", icon: Bell },
  { id: "todos", icon: ListChecks },
  { id: "notes", icon: StickyNote },
  { id: "people", icon: Users },
  { id: "assistant", icon: Sparkles },
];

export default function App() {
  const { t } = useTranslation();
  const [view, setView] = useState<View>("today");
  const [search, setSearch] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDemoPrompt, setShowDemoPrompt] = useState(false);
  const [seeding, setSeeding] = useState(false);
  // Bumped only on a data reset, to force every view to remount and reload.
  // (Not bumped on ordinary edits, so it never disrupts in-progress editing.)
  const [resetNonce, setResetNonce] = useState(0);
  // A specific item to open when navigating into a view (e.g. clicking a note
  // on the Today dashboard opens that note). Consumed by the view on mount and
  // cleared on any other navigation so it never mis-fires later.
  const [noteTarget, setNoteTarget] = useState<string | null>(null);
  const [calTarget, setCalTarget] = useState<string | null>(null);
  // The occurrence to open, so the calendar can jump to its month first.
  const [calTargetStart, setCalTargetStart] = useState<string | null>(null);
  const [todoTarget, setTodoTarget] = useState<string | null>(null);
  const [reminderTarget, setReminderTarget] = useState<string | null>(null);
  const [personTarget, setPersonTarget] = useState<string | null>(null);
  // The assistant conversation lives here, not in AssistantView: clicking an
  // item card navigates away, which would otherwise unmount the chat and lose it.
  const [chat, setChat] = useState<UiMessage[]>([]);
  // Whether the floating chat window is expanded. Deliberately not persisted:
  // a chat window that reopens itself on every launch is worse than one click.
  const [popupOpen, setPopupOpen] = useState(false);

  // Each view reloads its own data after mutations and on mount; switching
  // views remounts the next one, so no global refresh signal is needed.
  const bump = () => {};

  // Single entry point for view changes. Resets any pending open-target unless
  // one is passed for this navigation.
  function navigate(v: View, target?: NavTarget) {
    setNoteTarget(target?.noteId ?? null);
    setCalTarget(target?.eventId ?? null);
    setCalTargetStart(target?.eventStart ?? null);
    setTodoTarget(target?.todoId ?? null);
    setReminderTarget(target?.reminderId ?? null);
    setPersonTarget(target?.personId ?? null);
    setSearch("");
    setView(v);
  }

  /** Clear every pending open-target (search box, plain nav). */
  function clearTargets() {
    setNoteTarget(null); setCalTarget(null); setCalTargetStart(null);
    setTodoTarget(null); setReminderTarget(null); setPersonTarget(null);
  }

  useEffect(() => {
    (async () => {
      try {
        await db(); // open DB + run migrations up front
        startReminderPoller();
        setReady(true);
      } catch (e) {
        setError(String(e));
      }
    })();
  }, []);

  // Listen for the secret chord: Shift + 8 + 9 held together.
  const held = useRef<Set<string>>(new Set());
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      held.current.add(e.code);
      if (e.shiftKey && held.current.has("Digit8") && held.current.has("Digit9")) {
        held.current.clear();
        setShowDemoPrompt(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => held.current.delete(e.code);
    const clear = () => held.current.clear();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", clear);
    };
  }, []);

  async function loadDemo() {
    setSeeding(true);
    try {
      await resetAndSeedDemo();
      setShowDemoPrompt(false);
      setSearch("");
      setView("today");
      // The chat outlives view remounts now, so the reset has to clear it —
      // it would otherwise reference items that no longer exist.
      setChat([]);
      // Same reasoning for the reminder poller's "already fired" memory: the
      // ids it remembers now refer to deleted/replaced rows.
      resetNotificationState();
      clearTargets();
      setResetNonce((n) => n + 1); // remount views so they pick up the new data
    } finally {
      setSeeding(false);
    }
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-red-600">
        <div>
          <p className="font-semibold">{t("app.dbError")}</p>
          <p className="mt-2 text-sm text-neutral-500">{error}</p>
        </div>
      </div>
    );
  }
  if (!ready) {
    return <div className="flex h-full items-center justify-center text-neutral-400">{t("common.loading")}</div>;
  }

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <nav className="flex w-52 shrink-0 flex-col border-r border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-900">
        <div className="flex items-center gap-2 px-4 py-4 text-lg font-bold">
          <Brain size={22} className="shrink-0 text-blue-600" />
          <span className="min-w-0 truncate">{t("app.name")}</span>
        </div>
        <div className="px-2">
          <div className="relative mb-3">
            <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input
              value={search}
              onChange={(e) => { clearTargets(); setSearch(e.target.value); setView(e.target.value ? "search" : "today"); }}
              placeholder={t("app.searchPlaceholder")}
              className="w-full rounded-lg border border-neutral-200 py-1.5 pl-8 pr-3 text-sm outline-none focus:border-blue-400 dark:border-neutral-600 dark:bg-neutral-800"
            />
          </div>
        </div>
        <div className="flex-1 space-y-0.5 px-2">
          {NAV.map((n) => {
            const Icon = n.icon;
            return (
              <button
                key={n.id}
                onClick={() => navigate(n.id)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${
                  view === n.id ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
                }`}
              >
                <Icon size={18} className="shrink-0" />
                <span className="min-w-0 truncate">{t(`nav.${n.id}`)}</span>
              </button>
            );
          })}
        </div>
        <div className="px-2 pb-1">
          <button
            onClick={() => navigate("settings")}
            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${
              view === "settings" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
            }`}
          >
            <SettingsIcon size={18} className="shrink-0" />
            <span className="min-w-0 truncate">{t("nav.settings")}</span>
          </button>
        </div>
      </nav>

      {/* Main */}
      <main className="flex-1 overflow-hidden bg-neutral-50 dark:bg-neutral-900">
        {view === "today" && <TodayView key={resetNonce} onChange={bump} goTo={(v, target) => navigate(v as View, target)} />}
        {view === "calendar" && <CalendarView key={resetNonce} onChange={bump} openEventId={calTarget ?? undefined} openEventStart={calTargetStart ?? undefined} />}
        {view === "reminders" && <RemindersView key={resetNonce} onChange={bump} initialId={reminderTarget ?? undefined} />}
        {view === "todos" && <TodosView key={resetNonce} onChange={bump} initialId={todoTarget ?? undefined} />}
        {view === "notes" && <NotesView key={resetNonce} onChange={bump} initialId={noteTarget ?? undefined} />}
        {view === "people" && <PeopleView key={resetNonce} onChange={bump} initialId={personTarget ?? undefined} />}
        {view === "assistant" && (
          <AssistantView
            key={resetNonce}
            messages={chat}
            setMessages={setChat}
            goTo={(v, target) => navigate(v as View, target)}
          />
        )}
        {view === "settings" && <SettingsView />}
        {view === "search" && <SearchView query={search} goTo={(v, target) => navigate(v as View, target)} />}
      </main>

      {/* The floating chat window: outside <main> so navigating to an item card
          leaves it open, and so it floats above whatever view is mounted.
          Hidden on the assistant page (it *is* the assistant page there) and
          when there's no model configured — a button on every page that only
          says "go to Settings" is noise. isAssistantConfigured() reads
          localStorage, so it's recomputed on each render rather than held in
          state; a view change after adding a key is enough to reveal it. */}
      {view !== "assistant" && isAssistantConfigured() && (
        <AssistantPopup
          messages={chat}
          setMessages={setChat}
          goTo={(v, target) => navigate(v as View, target)}
          open={popupOpen}
          setOpen={setPopupOpen}
        />
      )}

      <Modal
        open={showDemoPrompt}
        onClose={() => !seeding && setShowDemoPrompt(false)}
        title={t("demo.title")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowDemoPrompt(false)}>{t("common.cancel")}</Button>
            <Button variant="danger" onClick={loadDemo}>
              <span className="flex items-center gap-1.5">
                <Sparkles size={15} /> {seeding ? t("common.loading") : t("demo.confirm")}
              </span>
            </Button>
          </>
        }
      >
        {/* <Trans> keeps the <strong> inline rather than splitting the sentence
            into fragments a translator can't reorder. */}
        <p className="text-sm text-neutral-600 dark:text-neutral-300">
          <Trans i18nKey="demo.body" components={{ strong: <strong /> }} />
        </p>
        <p className="mt-2 text-sm text-neutral-500">{t("demo.irreversible")}</p>
      </Modal>
    </div>
  );
}
