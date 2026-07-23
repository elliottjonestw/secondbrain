// Headlines from the user's subscribed feeds.
//
// Articles open in the user's own browser, never in-app: a news site is
// arbitrary third-party HTML, and this app has no place rendering it inside a
// webview that holds a signed-in session. Same call, and the same reasoning, as
// `YouTubeEmbed`.

import { useTranslation } from "react-i18next";
import { Rss } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CardShell, CardEmpty } from "./CardShell";
import { useAsync } from "./useAsync";
import { loadFeedItems, rssFeeds, rssItemCount } from "./dayData";
import type { TodayWidget, TodayWidgetProps } from "./types";
import type { FeedItem } from "../../lib/rss";
import { isTauri } from "../../lib/platform";
import { fmtDateTime } from "../../lib/format";

function RssCard({ viewingToday, revision }: TodayWidgetProps) {
  const { t: tr } = useTranslation();
  const feeds = rssFeeds();
  const limit = rssItemCount();

  // Mounting is the gate: a hidden card isn't rendered, so it never asks. That
  // matters here — every miss is a relayed request per subscribed feed.
  const { data: items, loading, error } = useAsync(
    () => (viewingToday && feeds.length
      ? loadFeedItems(feeds, revision)
      : Promise.resolve([] as FeedItem[])),
    [revision, viewingToday, limit, feeds.map((f) => f.url).join(",")],
  );

  // Nothing subscribed: the card would be a standing advert for a setting.
  if (!feeds.length) return null;
  // A feed describes now, so it says nothing about the day being viewed — the
  // same reason the ticker and the weather's `current` don't render elsewhere.
  if (!viewingToday) return null;

  const rows = (items ?? []).slice(0, limit);

  return (
    <CardShell
      icon={<Rss size={14} />}
      title={tr("today.rss")}
      loading={loading && items === undefined}
      error={error}
      skeletonLines={Math.min(limit, 4)}
    >
      {!rows.length ? (
        <CardEmpty>{tr("today.rssUnavailable")}</CardEmpty>
      ) : (
        <ul className="divide-y divide-neutral-100 dark:divide-neutral-700">
          {rows.map((item) => <ArticleRow key={item.link || item.id} item={item} />)}
        </ul>
      )}
    </CardShell>
  );
}

export const rssWidget: TodayWidget = {
  id: "rss",
  labelKey: "today.rssCard",
  Component: RssCard,
};

/** One headline: title, then its source and age. Not a link element — the
 *  navigation is a plugin call, and an `<a href>` that a middle-click could
 *  follow inside the webview is exactly what this avoids. */
function ArticleRow({ item }: { item: FeedItem }) {
  const open = () => {
    if (!item.link) return;
    if (isTauri()) void openUrl(item.link);
    else window.open(item.link, "_blank", "noopener");
  };

  return (
    <li>
      <button
        onClick={open}
        disabled={!item.link}
        className="w-full py-2 text-left first:pt-1 last:pb-1 disabled:cursor-default"
      >
        {/* Two lines, then clipped: headlines run long, and a card that grows
            with the day's news would push everything below it off the page. */}
        <span className="line-clamp-2 text-sm group-hover:text-blue-500">{item.title}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-xs text-neutral-400">
          <span className="truncate">{item.source}</span>
          {item.published && (
            <>
              <span aria-hidden="true">·</span>
              <span className="shrink-0">{fmtDateTime(item.published.toISOString())}</span>
            </>
          )}
        </span>
      </button>
    </li>
  );
}
