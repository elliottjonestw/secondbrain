import { useEffect, useState } from "react";
import { Home, Calendar, Bell, ListChecks, StickyNote, Search, Brain, LucideIcon } from "lucide-react";
import TodayView from "./views/TodayView";
import CalendarView from "./views/CalendarView";
import RemindersView from "./views/RemindersView";
import TodosView from "./views/TodosView";
import NotesView from "./views/NotesView";
import SearchView from "./views/SearchView";
import { startReminderPoller } from "./lib/notifications";
import { db } from "./db";

type View = "today" | "calendar" | "reminders" | "todos" | "notes" | "search";

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
        {view === "today" && <TodayView onChange={bump} goTo={(v) => setView(v as View)} />}
        {view === "calendar" && <CalendarView onChange={bump} />}
        {view === "reminders" && <RemindersView onChange={bump} />}
        {view === "todos" && <TodosView onChange={bump} />}
        {view === "notes" && <NotesView onChange={bump} />}
        {view === "search" && <SearchView query={search} goTo={(v) => { setView(v as View); setSearch(""); }} />}
      </main>
    </div>
  );
}
