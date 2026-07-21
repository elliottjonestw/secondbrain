import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

/**
 * The frame every Today widget renders into: header, and one of
 * skeleton / error / content.
 *
 * Centralising the states is what keeps a new widget from inventing its own
 * loading look — and it's why the page doesn't need Suspense to get a
 * declarative skeleton.
 */
export function CardShell({
  title, children, onHeaderClick, icon, action, loading, error, skeletonLines = 3,
}: {
  title: string;
  children: ReactNode;
  /** Makes the title a button, e.g. to jump to the full view. */
  onHeaderClick?: () => void;
  /** Sits before the title, for cards that aren't a plain list of items. */
  icon?: ReactNode;
  /** Header-right control, e.g. the summary's rewrite button. */
  action?: ReactNode;
  /**
   * Show the skeleton instead of `children`. Pass only when there's nothing to
   * show yet — on a refresh, keeping the previous content on screen beats
   * flashing a skeleton at someone who just ticked a checkbox.
   */
  loading?: boolean;
  /** Renders a quiet failure line in place of the content. */
  error?: unknown;
  skeletonLines?: number;
}) {
  const { t } = useTranslation();
  const heading = "text-sm font-semibold uppercase tracking-wide text-neutral-500";
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-800">
      <div className="mb-2 flex items-center justify-between gap-2">
        {onHeaderClick ? (
          <button onClick={onHeaderClick} className={`${heading} hover:text-blue-500`}>{title}</button>
        ) : (
          <div className={`flex items-center gap-1.5 ${heading}`}>{icon}{title}</div>
        )}
        {action}
      </div>
      <div>
        {loading ? (
          <CardSkeleton lines={skeletonLines} />
        ) : error ? (
          <CardEmpty>{t("today.cardFailed")}</CardEmpty>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

export function CardSkeleton({ lines = 3 }: { lines?: number }) {
  // Staggered widths so it reads as text rather than a loading bar.
  const widths = ["w-full", "w-4/5", "w-2/3", "w-3/4", "w-1/2"];
  return (
    <div className="space-y-2 py-1" aria-busy="true">
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className={`h-3 animate-pulse rounded bg-neutral-200 dark:bg-neutral-700 ${widths[i % widths.length]}`}
        />
      ))}
    </div>
  );
}

/** "Nothing here" line, shared so every card's empty state reads the same. */
export function CardEmpty({ children }: { children: ReactNode }) {
  return <p className="py-2 text-sm text-neutral-400">{children}</p>;
}
