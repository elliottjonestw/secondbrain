// AI assistant: builds a read-only snapshot of all app data and asks OpenAI
// questions about it. The request goes through tauri-plugin-http's fetch, which
// runs in Rust and therefore bypasses the browser CORS restriction that blocks
// calling api.openai.com directly from the webview.
//
// Read-only by design: the assistant only receives a data snapshot; it has no
// tools and cannot mutate anything.

import { fetch } from "@tauri-apps/plugin-http";
import { format } from "date-fns";
import {
  listEvents, listReminders, listTodos, listNotes, listLists, listTags, db,
} from "../db";
import { getSettings } from "./settings";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const PRIORITY = ["none", "low", "medium", "high"];

function fmt(iso: string | null): string {
  if (!iso) return "—";
  try { return format(new Date(iso), "EEE MMM d yyyy, h:mm a"); } catch { return iso; }
}

/** Assemble a compact, human-readable snapshot of everything in the app. */
export async function buildContext(): Promise<string> {
  const [events, reminders, todos, notes, lists, tags] = await Promise.all([
    listEvents(), listReminders(), listTodos(), listNotes(), listLists(), listTags(),
  ]);
  const listName = new Map(lists.map((l) => [l.id, l.name]));

  // tags per item, for annotation
  const d = await db();
  const itemTags = await d.select<{ tag_id: string; item_type: string; item_id: string }[]>(
    "SELECT tag_id, item_type, item_id FROM item_tags",
  );
  const tagName = new Map(tags.map((t) => [t.id, t.name]));
  const tagsFor = (type: string, id: string) =>
    itemTags.filter((it) => it.item_type === type && it.item_id === id)
      .map((it) => "#" + (tagName.get(it.tag_id) ?? "")).join(" ");

  const links = await d.select<{ source_type: string; source_id: string; target_type: string; target_id: string }[]>(
    "SELECT source_type, source_id, target_type, target_id FROM links",
  );

  const lines: string[] = [];
  lines.push(`CURRENT DATE/TIME: ${format(new Date(), "EEEE MMMM d, yyyy, h:mm a")}`);
  lines.push("");

  lines.push(`LISTS (${lists.length}): ${lists.map((l) => l.name).join(", ") || "none"}`);
  lines.push("");

  lines.push(`CALENDAR EVENTS (${events.length}):`);
  for (const e of events) {
    const t = tagsFor("event", e.id);
    lines.push(
      `- "${e.summary}" | ${e.all_day ? "all-day " + fmt(e.dtstart) : fmt(e.dtstart) + " → " + fmt(e.dtend)}` +
      `${e.rrule ? ` | repeats: ${e.rrule}` : ""}${e.location ? ` | at ${e.location}` : ""}` +
      `${e.description ? ` | ${e.description}` : ""}${t ? ` | ${t}` : ""}`,
    );
  }
  lines.push("");

  lines.push(`TO-DOS (${todos.length}):`);
  const byId = new Map(todos.map((t) => [t.id, t]));
  for (const t of todos) {
    const sub = t.parent_todo_id ? `subtask of "${byId.get(t.parent_todo_id)?.title ?? "?"}" | ` : "";
    const tag = tagsFor("todo", t.id);
    lines.push(
      `- [${t.completed ? "x" : " "}] "${t.title}" | list: ${listName.get(t.list_id ?? "") ?? "—"} | ` +
      `${sub}due: ${fmt(t.due_at)} | priority: ${PRIORITY[t.priority] ?? t.priority}` +
      `${t.notes ? ` | notes: ${t.notes}` : ""}${tag ? ` | ${tag}` : ""}`,
    );
  }
  lines.push("");

  lines.push(`REMINDERS (${reminders.length}):`);
  for (const r of reminders) {
    const tag = tagsFor("reminder", r.id);
    lines.push(
      `- [${r.completed ? "x" : " "}] "${r.title}" | due: ${fmt(r.due_at)} | alert: ${fmt(r.remind_at)}` +
      `${r.rrule ? ` | repeats: ${r.rrule}` : ""} | priority: ${PRIORITY[r.priority] ?? r.priority}` +
      `${r.notes ? ` | notes: ${r.notes}` : ""}${tag ? ` | ${tag}` : ""}`,
    );
  }
  lines.push("");

  lines.push(`NOTES (${notes.length}):`);
  for (const n of notes) {
    const tag = tagsFor("note", n.id);
    const body = (n.body ?? "").replace(/\s+/g, " ").slice(0, 800);
    lines.push(`- "${n.title || "Untitled"}"${n.pinned ? " (pinned)" : ""}${tag ? ` ${tag}` : ""}: ${body}`);
  }
  lines.push("");

  if (links.length) {
    lines.push(`LINKS (${links.length}): items explicitly linked to each other:`);
    for (const l of links) lines.push(`- ${l.source_type}:${l.source_id} ↔ ${l.target_type}:${l.target_id}`);
  }

  return lines.join("\n");
}

const SYSTEM_PROMPT =
  "You are a helpful personal assistant embedded in a local life-management app called Second Brain. " +
  "You answer the user's questions about THEIR data — calendar events, reminders, to-dos, notes, lists, and tags — " +
  "using only the snapshot provided below. You are READ-ONLY: you cannot create, edit, or delete anything; " +
  "if asked to make changes, explain that you can only answer questions for now. " +
  "Be concise and specific. Reference dates/times in a natural way relative to the current date given. " +
  "If the answer isn't in the data, say so plainly rather than guessing.\n\n" +
  "===== USER DATA SNAPSHOT =====\n";

/**
 * Ask the assistant a question. `history` is the prior visible conversation
 * (user/assistant turns); the data snapshot + system prompt are added here.
 * Returns the assistant's reply text.
 */
export async function askAssistant(history: ChatMessage[]): Promise<string> {
  const { openaiApiKey, openaiModel } = getSettings();
  if (!openaiApiKey.trim()) {
    throw new Error("No OpenAI API key set. Add one in Settings.");
  }

  const context = await buildContext();
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT + context },
    ...history,
  ];

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openaiApiKey.trim()}`,
    },
    body: JSON.stringify({ model: openaiModel, messages, temperature: 0.2 }),
  });

  if (!res.ok) {
    let detail = "";
    try {
      const err = await res.json();
      detail = err?.error?.message ?? JSON.stringify(err);
    } catch {
      detail = await res.text();
    }
    throw new Error(`OpenAI error (${res.status}): ${detail}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty response from OpenAI.");
  return content as string;
}
