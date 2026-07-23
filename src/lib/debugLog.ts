// Opt-in runtime diagnostics for the "Still loading…" banner investigation.
//
// Everything here is inert unless `localStorage["sb.debug"] === "1"`, so it can
// live in the shipped bundle at zero cost and be switched on from the console
// on the exact device that reproduces the bug:
//
//   localStorage.setItem("sb.debug", "1"); location.reload();
//
// It answers the questions static reading can't: is a gated view *remounting*
// on its own, or is one first load simply taking >8s? Did the machine sleep, or
// the tab change visibility, just before it happened?

let enabled = false;
try {
  enabled = localStorage.getItem("sb.debug") === "1";
} catch {
  /* storage blocked — stay off */
}

export function debugEnabled(): boolean {
  return enabled;
}

/** Timestamped console line, only when diagnostics are on. */
export function dbg(...args: unknown[]): void {
  if (!enabled) return;
  const t = new Date();
  // eslint-disable-next-line no-console
  console.info(`[sb ${t.toLocaleTimeString()}.${String(t.getMilliseconds()).padStart(3, "0")}]`, ...args);
}

let installed = false;

/**
 * Wire up the environment-level watchers: page lifecycle events, and a
 * heartbeat that spots the wall-clock jumping (which means the machine slept or
 * the tab was frozen). Logging these next to the view-mount lines lets us line
 * up "the banner appeared" with "and the laptop had just woken", if that's what
 * is happening. Idempotent and a no-op when diagnostics are off.
 */
export function installLoadingDiagnostics(): void {
  if (!enabled || installed) return;
  installed = true;

  const log = (label: string) => () =>
    dbg(`event:${label}`, { visibility: document.visibilityState, online: navigator.onLine });

  document.addEventListener("visibilitychange", log("visibilitychange"));
  window.addEventListener("focus", log("focus"));
  window.addEventListener("blur", log("blur"));
  window.addEventListener("online", log("online"));
  window.addEventListener("offline", log("offline"));
  window.addEventListener("pageshow", (e) =>
    dbg("event:pageshow", { persisted: (e as PageTransitionEvent).persisted }),
  );
  window.addEventListener("pagehide", (e) =>
    dbg("event:pagehide", { persisted: (e as PageTransitionEvent).persisted }),
  );

  const BEAT_MS = 15_000;
  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    const gap = now - last;
    // A gap well over the interval means timers were suspended — sleep, freeze,
    // or a long GC/main-thread stall. That is the prime suspect for a stale
    // connection, so call it out loudly.
    if (gap > BEAT_MS * 2) dbg(`SLEEP/FREEZE gap ${(gap / 1000).toFixed(1)}s — connection may now be stale`);
    last = now;
  }, BEAT_MS);

  dbg("diagnostics installed");
}
