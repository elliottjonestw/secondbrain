// Native OS notifications for due reminders and todos.
//
// The desktop notification plugin has no reliable cross-platform "schedule this
// for later" API, so we poll from the running app: every minute we look for
// reminders/todos whose alert time has passed and fire a notification once.
// Fully offline; no network involved.

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import i18next from "i18next";
import { listReminders, listTodos } from "../db";

const CHECK_INTERVAL_MS = 60_000;
// Ids we've already notified this session, so we don't nag every minute.
const notified = new Set<string>();

export async function ensureNotificationPermission(): Promise<boolean> {
  let granted = await isPermissionGranted();
  if (!granted) {
    const perm = await requestPermission();
    granted = perm === "granted";
  }
  return granted;
}

async function checkDue(): Promise<void> {
  const granted = await isPermissionGranted();
  if (!granted) return;

  const now = Date.now();

  const reminders = await listReminders();
  for (const r of reminders) {
    if (r.completed) continue;
    const at = r.remind_at || r.due_at;
    if (!at) continue;
    const t = new Date(at).getTime();
    const key = `reminder:${r.id}:${at}`;
    if (t <= now && !notified.has(key)) {
      notified.add(key);
      sendNotification({ title: i18next.t("itemType.reminder"), body: r.title });
    }
  }

  const todos = await listTodos();
  for (const td of todos) {
    if (td.completed || !td.due_at) continue;
    const t = new Date(td.due_at).getTime();
    const key = `todo:${td.id}:${td.due_at}`;
    if (t <= now && !notified.has(key)) {
      notified.add(key);
      sendNotification({ title: i18next.t("notifications.todoDue"), body: td.title });
    }
  }
}

let timer: number | null = null;

/** Start the background poller. Safe to call once at app startup. */
export function startReminderPoller(): void {
  if (timer !== null) return;
  void checkDue();
  timer = window.setInterval(() => void checkDue(), CHECK_INTERVAL_MS);
}
