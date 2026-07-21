import { useTranslation } from "react-i18next";
import { CardShell, CardEmpty } from "./CardShell";
import { useAsync } from "./useAsync";
import { loadQuotes, watchlist } from "./dayData";
import type { TodayWidget, TodayWidgetProps } from "./types";
import type { Quote } from "../../lib/stocks";
import { fmtPrice, fmtChangePercent } from "../../lib/format";

function Stocks({ viewingToday, revision }: TodayWidgetProps) {
  const { t: tr } = useTranslation();
  const symbols = watchlist();

  // Mounting is the gate: a hidden card isn't rendered, so it never asks. That
  // matters here — this hits an endpoint nobody is paying for, once per symbol.
  const { data: quotes, loading, error } = useAsync(
    () => (viewingToday && symbols.length
      ? loadQuotes(symbols, revision)
      : Promise.resolve([])),
    [revision, viewingToday, symbols.map((s) => s.symbol).join(",")],
  );

  // Nothing on the watchlist: the card would be a standing advert for a setting.
  if (!symbols.length) return null;
  // A quote describes *now*, so it says nothing about the day being viewed —
  // the same reason the weather card won't render `current` on another day.
  if (!viewingToday) return null;

  const rows = (quotes ?? [])
    .map((quote, i) => ({ quote, symbol: symbols[i] }))
    .filter((r): r is { quote: Quote; symbol: (typeof symbols)[number] } => !!r.quote);

  return (
    <CardShell
      title={tr("today.stocks")}
      loading={loading && quotes === undefined}
      error={error}
      skeletonLines={symbols.length > 3 ? 3 : symbols.length}
    >
      {!rows.length ? (
        <CardEmpty>{tr("today.stocksUnavailable")}</CardEmpty>
      ) : (
        <ul className="divide-y divide-neutral-100 dark:divide-neutral-700">
          {rows.map((r) => <QuoteRow key={r.quote.symbol} quote={r.quote} name={r.symbol.name} />)}
        </ul>
      )}
    </CardShell>
  );
}

export const stocksWidget: TodayWidget = {
  id: "stocks",
  labelKey: "today.stocksCard",
  Component: Stocks,
};

/**
 * One instrument: ticker and name, the day's shape, then price and move.
 *
 * `name` comes from the stored watchlist rather than the quote — it's what the
 * user picked in Settings, so the row reads the same whether or not the service
 * bothered to send a short name back this time.
 */
function QuoteRow({ quote, name }: { quote: Quote; name: string }) {
  const { t: tr } = useTranslation();
  // Flat counts as up: a zero move renders neutral-positive rather than red,
  // which is how every ticker draws it.
  const down = quote.change < 0;
  const tone = down ? "text-red-500" : "text-green-600";

  return (
    <li className="flex items-center gap-3 py-2 first:pt-1 last:pb-1">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-semibold">{quote.symbol}</span>
          {/* Only worth saying when it isn't trading — an open market is the
              assumption, and a badge on every row all day is just noise. */}
          {!quote.marketOpen && (
            <span className="shrink-0 rounded bg-neutral-100 px-1 text-[10px] text-neutral-400 dark:bg-neutral-700">
              {tr("today.marketClosed")}
            </span>
          )}
        </div>
        <div className="truncate text-xs text-neutral-400">{name}</div>
      </div>

      <Sparkline points={quote.points} baseline={quote.previousClose} down={down} />

      {/* A floor on the width so the sparklines line up down the card rather
          than stepping in and out with the length of each price. */}
      <div className="min-w-20 shrink-0 text-right">
        <div className="text-sm tabular-nums">{fmtPrice(quote.price, quote.currency)}</div>
        <div className={`text-xs tabular-nums ${tone}`}>{fmtChangePercent(quote.changePercent)}</div>
      </div>
    </li>
  );
}

const SPARK_W = 64;
const SPARK_H = 24;

/**
 * The day's trace, drawn against the previous close.
 *
 * Scaled to include `baseline` so the line sits above or below it the way the
 * change figure says it does — scaling to the data alone would draw a day that
 * fell all morning as a confident climb off its own low.
 *
 * Hand-rolled SVG rather than a chart library: it's a polyline, and the app
 * doesn't otherwise carry a charting dependency.
 */
function Sparkline({ points, baseline, down }: { points: number[]; baseline: number; down: boolean }) {
  // One point can't make a line, and a flat series has no shape worth drawing.
  if (points.length < 2) return null;

  const lo = Math.min(baseline, ...points);
  const hi = Math.max(baseline, ...points);
  // A perfectly flat day would divide by zero; draw it down the middle.
  const span = hi - lo || 1;

  const x = (i: number) => (i / (points.length - 1)) * SPARK_W;
  const y = (v: number) => SPARK_H - ((v - lo) / span) * SPARK_H;

  const path = points.map((p, i) => `${x(i).toFixed(1)},${y(p).toFixed(1)}`).join(" ");
  const stroke = down ? "#ef4444" : "#16a34a";

  return (
    <svg
      width={SPARK_W}
      height={SPARK_H}
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      className="shrink-0 overflow-visible"
      aria-hidden="true"
    >
      {/* Where the previous close sits, so the trace has something to mean. */}
      <line
        x1={0}
        y1={y(baseline)}
        x2={SPARK_W}
        y2={y(baseline)}
        stroke="currentColor"
        strokeWidth={1}
        strokeDasharray="2 2"
        className="text-neutral-200 dark:text-neutral-600"
      />
      <polyline
        points={path}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
