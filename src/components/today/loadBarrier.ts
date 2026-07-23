// The Today page's first-load barrier.
//
// The other views gate behind `useFirstLoad`, which runs the view's single
// `load()` and shows a spinner until it settles. Today has no single load: each
// widget owns its data (see `types.ts`), so there's nothing central to wait on
// and the page used to draw its frame immediately with every card mid-skeleton.
//
// This is the missing central thing. Every widget's load goes through
// `useAsync`, so making that one hook report its *first* settle here lets Today
// block exactly as the other pages do — without any widget knowing the barrier
// exists, and without hoisting a load out of the card that owns it.
//
// Only first loads count. A revision bump (a mutation) or a day step re-runs a
// widget's load, but `useAsync` reports only its opening fetch, so the page is
// never re-blocked after it has once been shown — matching "only the first load
// blocks" from the other views.

import { createContext, useContext, useEffect, useState } from "react";

/** How long the page may block before it's shown regardless. Mirrors ViewGate. */
const SLOW_AFTER_MS = 8000;

/**
 * Counts the widgets' opening loads and reports when the last one lands.
 *
 * `begin()` is called once per `useAsync` as it mounts; the returned function is
 * called when that load first settles (success *or* failure — a failed widget
 * shows its own error in its card and must not hold the whole page). The page is
 * ready once every begun load has settled *and* the barrier has been sealed, so
 * a load that resolves before its siblings have even registered can't trip the
 * count to zero early.
 */
export class LoadBarrier {
  private pending = 0;
  private sealed = false;
  private ready = false;
  private listeners = new Set<() => void>();

  begin(): () => void {
    this.pending++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.pending--;
      this.check();
    };
  }

  /**
   * No more widgets will register. Called from the page's own effect, which runs
   * after every child's — so by now `pending` reflects all of them. Before this,
   * a transient `pending === 0` (the first load settling before the second
   * begins) is ignored.
   */
  seal(): void {
    this.sealed = true;
    this.check();
  }

  isReady(): boolean {
    return this.ready;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private check(): void {
    if (this.ready || !this.sealed || this.pending > 0) return;
    this.ready = true;
    this.listeners.forEach((fn) => fn());
  }
}

const BarrierContext = createContext<LoadBarrier | null>(null);

/** Wraps the widget grid so each `useAsync` under it can find the barrier. */
export const BarrierProvider = BarrierContext.Provider;

/** The barrier a widget's `useAsync` reports into, or null outside Today. */
export function useTodayBarrier(): LoadBarrier | null {
  return useContext(BarrierContext);
}

export type BarrierStatus = "loading" | "slow" | "ready";

/**
 * Watch a barrier settle, with the slow-load escape hatch the other views have.
 *
 * Returns "loading" until every widget's opening load lands, then "ready". If
 * that takes longer than SLOW_AFTER_MS the page is shown anyway as "slow" (the
 * caller floats a still-loading marker) — the worst case is a fully rendered
 * page with cards still filling in, never a spinner that never clears.
 *
 * Seals the barrier from *this* effect, which React runs after the widgets'
 * effects, so every widget has registered its load before the count is trusted.
 */
export function useBarrierGate(barrier: LoadBarrier): BarrierStatus {
  const [status, setStatus] = useState<BarrierStatus>(() => (barrier.isReady() ? "ready" : "loading"));

  useEffect(() => {
    if (barrier.isReady()) { setStatus("ready"); return; }
    const unsub = barrier.subscribe(() => setStatus("ready"));
    const slow = setTimeout(
      () => setStatus((s) => (s === "loading" ? "slow" : s)),
      SLOW_AFTER_MS,
    );
    // Every child widget has mounted and registered its load by now.
    barrier.seal();
    return () => { unsub(); clearTimeout(slow); };
  }, [barrier]);

  return status;
}
