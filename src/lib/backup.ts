// Full-data backup: export/import everything the app stores for the user as a
// single JSON file. Scope = all SQLite user data (via db.ts) plus non-secret
// settings. Deliberately EXCLUDES the OpenAI API key and the CalDAV account
// (Apple ID + app-specific password + discovered calendars) — device-bound
// secrets that must not travel in a portable backup file. Mirrors ics.ts's
// native save/open + fs pattern so it works the same in a packaged build.

import i18next from "i18next";
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import { DATA_TABLES, exportTables, importTables, type DataTable } from "../db";
import {
  getSettings, saveSettings, getCalendarSettings, saveCalendarSettings,
} from "./settings";

type Row = Record<string, unknown>;

const BACKUP_VERSION = 1;

/** The non-secret slice of settings a backup carries. Never the API key or the
 *  CalDAV account — see the module note. */
interface BackupSettings {
  openaiModel?: string;
  sttModel?: string;
  language?: string;
  localVisible?: boolean;
  defaultCalendarId?: string;
}

export interface BackupFile {
  app: "secondbrain";
  version: number;
  exportedAt: string; // ISO
  settings: BackupSettings;
  tables: Partial<Record<DataTable, Row[]>>;
}

/** Serialize all user data + non-secret settings to a pretty JSON string. */
export async function buildBackup(): Promise<string> {
  const s = getSettings();
  const cal = getCalendarSettings();
  const backup: BackupFile = {
    app: "secondbrain",
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    settings: {
      openaiModel: s.openaiModel,
      sttModel: s.sttModel,
      language: s.language,
      localVisible: cal.localVisible,
      defaultCalendarId: cal.defaultCalendarId,
    },
    tables: await exportTables(),
  };
  return JSON.stringify(backup, null, 2);
}

/** Export everything to a JSON file chosen via the native save dialog.
 *  Returns the written path, or null if the user cancelled. */
export async function exportBackup(): Promise<string | null> {
  const json = await buildBackup();
  const path = await save({
    title: i18next.t("settings.data.exportTitle"),
    defaultPath: `second-brain-backup-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (!path) return null;
  await writeTextFile(path, json);
  return path;
}

export interface ImportResult {
  itemCount: number;
  /** Images whose bytes couldn't be re-uploaded because the account's daily
   *  image budget ran out mid-restore. Their notes came back with the reference
   *  intact and the missing-image chip in place, so this is a warning to show,
   *  not a failure. */
  imagesSkipped: number;
}

/** Restore from a user-selected backup JSON file. DESTRUCTIVE — replaces all
 *  existing data. Returns null if the user cancelled, else a summary. Throws a
 *  localized error on a malformed file. */
export async function importBackup(): Promise<ImportResult | null> {
  const path = await open({
    title: i18next.t("settings.data.importTitle"),
    multiple: false,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (!path || Array.isArray(path)) return null;
  const text = await readTextFile(path);
  return applyBackup(text);
}

/** Parse + validate a backup string and apply it. Exported for tests. */
export async function applyBackup(text: string): Promise<ImportResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(i18next.t("settings.data.errorInvalid"));
  }
  const backup = parsed as Partial<BackupFile>;
  if (!backup || backup.app !== "secondbrain" || typeof backup.tables !== "object" ||
      typeof backup.version !== "number") {
    throw new Error(i18next.t("settings.data.errorInvalid"));
  }
  // Refuse backups from a newer app: importTables would silently drop columns
  // and tables it doesn't recognize, losing data the user can't see is missing.
  // Same-version and older-version backups apply normally.
  if (backup.version > BACKUP_VERSION) {
    throw new Error(i18next.t("settings.data.errorNewer"));
  }

  // Keep only known tables; anything else in the file is ignored. importTables
  // further drops unknown columns per table, so a foreign key/typo can't throw.
  const tables: Partial<Record<DataTable, Row[]>> = {};
  let itemCount = 0;
  const src = backup.tables as Record<string, unknown>;
  for (const t of DATA_TABLES) {
    const rows = src[t];
    if (Array.isArray(rows)) {
      tables[t] = rows as Row[];
      itemCount += rows.length;
    }
  }
  const imagesSkipped = await importTables(tables);

  // Restore only the non-secret settings that are present — never the API key
  // or the CalDAV account, which aren't in the file to begin with.
  const st = backup.settings;
  if (st && typeof st === "object") {
    const appPatch: Parameters<typeof saveSettings>[0] = {};
    if (typeof st.openaiModel === "string") appPatch.openaiModel = st.openaiModel;
    if (typeof st.sttModel === "string") appPatch.sttModel = st.sttModel;
    if (typeof st.language === "string") appPatch.language = st.language;
    if (Object.keys(appPatch).length) saveSettings(appPatch);

    const calPatch: Parameters<typeof saveCalendarSettings>[0] = {};
    if (typeof st.localVisible === "boolean") calPatch.localVisible = st.localVisible;
    if (typeof st.defaultCalendarId === "string") calPatch.defaultCalendarId = st.defaultCalendarId;
    if (Object.keys(calPatch).length) saveCalendarSettings(calPatch);
  }

  return { itemCount, imagesSkipped };
}
