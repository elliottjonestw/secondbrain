import { useEffect, useState } from "react";
import { Home, Calendar, Bell, ListChecks, StickyNote, Users, Search, Brain, Sparkles, Settings as SettingsIcon, LogOut, LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import TodayView from "./views/TodayView";
import CalendarView from "./views/CalendarView";
import RemindersView from "./views/RemindersView";
import TodosView from "./views/TodosView";
import NotesView from "./views/NotesView";
import PeopleView from "./views/PeopleView";
import SearchView from "./views/SearchView";
import AssistantView from "./views/AssistantView";
import AssistantPopup from "./components/assistant/AssistantPopup";
import { useAssistantChat, type UiMessage } from "./components/assistant/useAssistantChat";
import SettingsView from "./views/SettingsView";
import type { NavTarget } from "./types";
import { startReminderPoller } from "./lib/notifications";
import { warmSession } from "./lib/api";
import { installLoadingDiagnostics } from "./lib/debugLog";
import { isAssistantConfigured } from "./lib/settings";
import { logout } from "./lib/auth";
import { getCachedSession } from "./lib/authStore";

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
  const [chatMessages, setChatMessages] = useState<UiMessage[]>([]);
  // Whether the floating chat window is expanded. Deliberately not persisted:
  // a chat window that reopens itself on every launch is worse than one click.
  const [popupOpen, setPopupOpen] = useState(false);
  // The turn/voice lifecycle lives here for the same reason the transcript
  // does, only more so: the popup unmounts when you navigate to the assistant
  // page, and a hook instance owned by the popup took its in-flight turn with
  // it — the unmount cleanup aborted the request, and deliver() drops the
  // cancelled user message, so "Open in Assistant" right after sending wiped
  // what you'd just typed. One instance in App means the handoff is pure
  // navigation: the message, the thinking indicator and the reply all survive.
  // Space-to-talk follows whichever surface is actually on screen.
  const chat = useAssistantChat({
    messages: chatMessages,
    setMessages: setChatMessages,
    spaceEnabled: isAssistantConfigured() && (view === "assistant" || popupOpen),
  });

  // Read once per render rather than held in state: AuthGate remounts this
  // whole tree on a different user, so it cannot go stale underneath us.
  const account = getCachedSession();

  async function signOut() {
    await logout();
    // A full reload is the simplest correct reset. Every module-scoped cache in
    // the app — dayData's revision counter, the notification poller's fired
    // set, the assistant transcript — would otherwise survive into the next
    // session, and enumerating them is a list that silently grows.
    window.location.reload();
  }

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

  // No database to open any more — the data lives behind the API, and the
  // AuthGate above this component has already established a session by the
  // time it mounts. All that's left is to start the reminder poller.
  useEffect(() => {
    startReminderPoller();
    installLoadingDiagnostics();
    setReady(true);
  }, []);

  // The access token lives 15 minutes in memory and isn't persisted, so after
  // the tab has been hidden past that, the first navigation back has to refresh
  // before it can load — and a socket that went stale while the tab slept makes
  // that refresh slow enough to flash the "Still loading…" banner behind a
  // view's first-load gate. Re-mint the token the moment the tab is visible
  // again (or the network returns) so that cost is paid in the background
  // instead of on screen. `warmSession` is a no-op when signed out or already
  // fresh, and deduped against any refresh already in flight.
  useEffect(() => {
    const warm = () => { if (document.visibilityState === "visible") void warmSession(); };
    document.addEventListener("visibilitychange", warm);
    window.addEventListener("online", warm);
    return () => {
      document.removeEventListener("visibilitychange", warm);
      window.removeEventListener("online", warm);
    };
  }, []);


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
        {/* Account row. Signing out unmounts the whole tree via AuthGate,
            which is what clears the assistant transcript and aborts any turn
            in flight — both correct when someone else may be about to sign in. */}
        <div className="border-t border-neutral-200 px-4 py-2 dark:border-neutral-700">
          <p className="truncate text-xs text-neutral-500" title={account?.user.email}>
            {account?.user.email}
          </p>
          <button
            onClick={signOut}
            className="mt-1 flex items-center gap-1.5 text-xs font-medium text-neutral-500 hover:text-red-600"
          >
            <LogOut size={13} className="shrink-0" />
            {t("auth.signOut")}
          </button>
        </div>

        <div className="px-2 pb-1 pt-1">
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
        {view === "today" && <TodayView onChange={bump} goTo={(v, target) => navigate(v as View, target)} />}
        {view === "calendar" && <CalendarView onChange={bump} openEventId={calTarget ?? undefined} openEventStart={calTargetStart ?? undefined} />}
        {view === "reminders" && <RemindersView onChange={bump} initialId={reminderTarget ?? undefined} />}
        {view === "todos" && <TodosView onChange={bump} initialId={todoTarget ?? undefined} />}
        {view === "notes" && <NotesView onChange={bump} initialId={noteTarget ?? undefined} />}
        {view === "people" && <PeopleView onChange={bump} initialId={personTarget ?? undefined} />}
        {view === "assistant" && (
          <AssistantView
           
            chat={chat}
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
          chat={chat}
          goTo={(v, target) => navigate(v as View, target)}
          open={popupOpen}
          setOpen={setPopupOpen}
        />
      )}

    </div>
  );
}
