import { OfflineError } from "./api";

/**
 * A durable snapshot of the last successful read of each remote collection,
 * kept in IndexedDB so offline reads survive an app restart.
 *
 * The strategy is deliberately network-FIRST, not stale-while-revalidate: every
 * read hits the server and, on success, overwrites the snapshot; the snapshot
 * is served only when the network fails. That trades instant-render for
 * simplicity and honesty — a value shown is either fresh or explicitly the last
 * thing seen before going offline, never silently stale while online. Because a
 * successful read always refreshes the snapshot, writes need no explicit cache
 * invalidation: the reload that every mutation triggers repopulates it.
 *
 * IndexedDB rather than localStorage because it is the one storage API present
 * on every target — desktop webview, browser tab, iOS and Android — and because
 * localStorage is synchronous and size-capped. Raw IndexedDB rather than a
 * wrapper dependency: the surface used here is three operations.
 */

const DB_NAME = "secondbrain-cache";
const STORE = "responses";
const VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Run `fetcher`; on success snapshot the result and return it. If it fails
 * because the device is offline, return the last snapshot instead — and only
 * then. Any other error (a real 4xx/5xx from the server) propagates untouched,
 * because serving stale data in place of a genuine server error would hide bugs.
 *
 * IndexedDB failures are swallowed: a browser with storage disabled must still
 * work online, just without the offline fallback.
 */
export async function networkFirst<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  try {
    const fresh = await fetcher();
    void idbPut(key, fresh).catch(() => {});
    return fresh;
  } catch (err) {
    if (err instanceof OfflineError) {
      const cached = await idbGet<T>(key).catch(() => undefined);
      if (cached !== undefined) return cached;
    }
    throw err;
  }
}

/** Drop the whole cache. Called on sign-out so one account's snapshots can
 *  never be served to the next. */
export async function clearCache(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
