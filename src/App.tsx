import { useEffect, useRef, useState } from "react";
import { Home, Calendar, Bell, ListChecks, StickyNote, Search, Brain, Sparkles, LucideIcon } from "lucide-react";
import TodayView from "./views/TodayView";
import CalendarView from "./views/CalendarView";
import RemindersView from "./views/RemindersView";
import TodosView from "./views/TodosView";
import NotesView from "./views/NotesView";
import SearchView from "./views/SearchView";
import { startReminderPoller } from "./lib/notifications";
import { db } from "./db";
import { resetAndSeedDemo } from "./lib/demo";
import { Modal, Button } from "./components/ui";

type View = "today" | "calendar" | "reminders" | "todos" | "notes" | "search";

// Secret keystroke: hold Shift + 8 + 9 together anywhere in the app to open the
// "load demo data" prompt. Keys are matched by physical code so it works
// regardless of what Shift+8/9 types on the user's layout.

const NAV: { id: View; label: string; icon: LucideIcon }[] = [
  { id: "today", label: "Today", icon: Home },
  { id: "calendar", label: "Calendar", icon: Calendar },
  { id: "reminders", label: "Reminders", icon: Bell },
  { id: "todos", label: "To-Do", icon: ListChecks },
  { id: "notes", label: "Notes", icon: StickyNote },
];

export default function App() {
  const [view, setView] = useState<View>("today");
  const [search, setSearch] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDemoPrompt, setShowDemoPrompt] = useState(false);
  const [seeding, setSeeding] = useState(false);
  // Bumped only on a data reset, to force every view to remount and reload.
  // (Not bumped on ordinary edits, so it never disrupts in-progress editing.)
  const [resetNonce, setResetNonce] = useState(0);

  // Each view reloads its own data after mutations and on mount; switching
  // views remounts the next one, so no global refresh signal is needed.
  const bump = () => {};

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
      setResetNonce((n) => n + 1); // remount views so they pick up the new data
    } finally {
      setSeeding(false);
    }
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-red-600">
        <div>
          <p className="font-semibold">Failed to open the database.</p>
          <p className="mt-2 text-sm text-neutral-500">{error}</p>
        </div>
      </div>
    );
  }
  if (!ready) {
    return <div className="flex h-full items-center justify-center text-neutral-400">Loading…</div>;
  }

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <nav className="flex w-52 shrink-0 flex-col border-r border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-900">
        <div className="flex items-center gap-2 px-4 py-4 text-lg font-bold">
          <Brain size={22} className="text-blue-600" /> Second Brain
        </div>
        <div className="px-2">
          <div className="relative mb-3">
            <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setView(e.target.value ? "search" : "today"); }}
              placeholder="Search everything…"
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
                onClick={() => { setView(n.id); setSearch(""); }}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${
                  view === n.id ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
                }`}
              >
                <Icon size={18} /> {n.label}
              </button>
            );
          })}
        </div>
        <div className="p-3 text-xs text-neutral-400">Local · offline · SQLite</div>
      </nav>

      {/* Main */}
      <main className="flex-1 overflow-hidden bg-neutral-50 dark:bg-neutral-900">
        {view === "today" && <TodayView key={resetNonce} onChange={bump} goTo={(v) => setView(v as View)} />}
        {view === "calendar" && <CalendarView key={resetNonce} onChange={bump} />}
        {view === "reminders" && <RemindersView key={resetNonce} onChange={bump} />}
        {view === "todos" && <TodosView key={resetNonce} onChange={bump} />}
        {view === "notes" && <NotesView key={resetNonce} onChange={bump} />}
        {view === "search" && <SearchView query={search} goTo={(v) => { setView(v as View); setSearch(""); }} />}
      </main>

      <Modal
        open={showDemoPrompt}
        onClose={() => !seeding && setShowDemoPrompt(false)}
        title="Load demo data?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowDemoPrompt(false)}>Cancel</Button>
            <Button variant="danger" onClick={loadDemo}>
              <span className="flex items-center gap-1.5">
                <Sparkles size={15} /> {seeding ? "Loading…" : "Reset & load demo"}
              </span>
            </Button>
          </>
        }
      >
        <p className="text-sm text-neutral-600 dark:text-neutral-300">
          You found the secret! This will <strong>permanently delete all of your current
          events, reminders, to-dos, notes, lists, tags, and links</strong>, then fill the
          app with a sample dataset to explore.
        </p>
        <p className="mt-2 text-sm text-neutral-500">This cannot be undone.</p>
      </Modal>
    </div>
  );
}
