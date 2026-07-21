// Renders a YouTube link in the note preview as a playable video card, which
// opens the video in its own window (see `openVideo` for why it can't be an
// inline iframe).
//
// Notes stay plain markdown: what's stored is an ordinary watch URL on its own
// line, so the body is still portable, still searchable, and nothing here
// touches SQLite. Raw HTML is deliberately NOT enabled (no `rehype-raw`) — the
// bodies rendered here can be written by the assistant, so widening the
// renderer to arbitrary HTML for this one feature is the wrong trade.

import { ComponentPropsWithoutRef, ReactNode, useState } from "react";
import { Play } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
import { isTauri } from "../db";

const ID = "[A-Za-z0-9_-]{11}";

/** Every shape a YouTube reference arrives in: the address bar, the Share
 *  button, the "Copy embed code" iframe, or a bare id typed by hand. */
const PATTERNS = [
  new RegExp(`youtube(?:-nocookie)?\\.com/(?:watch\\?(?:[^"'\\s]*&)?v=)(${ID})`, "i"),
  new RegExp(`youtube(?:-nocookie)?\\.com/(?:embed|v|shorts|live)/(${ID})`, "i"),
  new RegExp(`youtu\\.be/(${ID})`, "i"),
];

/**
 * Pull the video id out of a URL, an `<iframe>` snippet, or a bare id.
 * Returns null for anything else — including non-YouTube URLs, which must keep
 * rendering as ordinary links.
 */
export function youTubeId(input: string | undefined): string | null {
  const text = input?.trim();
  if (!text) return null;
  if (new RegExp(`^${ID}$`).test(text)) return text;
  for (const re of PATTERNS) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return null;
}

/** The canonical form stored in a note body. Bare and on its own line, so
 *  remark-gfm autolinks it and the `a` override can turn it into a player. */
export function youTubeUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

/**
 * True when a link was written as a bare URL (remark-gfm autolinked it, so the
 * link text is the href) rather than as `[label](url)`. Only bare URLs become
 * players — a link someone deliberately labelled stays a link.
 */
export function isBareLink(href: string, text: string): boolean {
  const norm = (s: string) => s.trim().replace(/\/$/, "").replace(/^https?:\/\//, "");
  return norm(href) === norm(text);
}

/**
 * Rewrite any YouTube embed `<iframe>` sitting in a body into its bare URL.
 *
 * Applied to the preview string only — never to what's stored — so notes
 * written before this feature existed, pasted outside the editor, or produced
 * by the assistant still render as players instead of silently vanishing
 * (react-markdown drops raw HTML).
 */
export function normalizeEmbeds(body: string): string {
  return body.replace(/<iframe\b[^>]*>\s*<\/iframe>|<iframe\b[^>]*\/?>/gi, (tag) => {
    const id = youTubeId(tag);
    // A non-YouTube iframe is left exactly as it was: it renders as nothing,
    // which is what it already did, rather than being quietly deleted.
    return id ? `\n\n${youTubeUrl(id)}\n\n` : tag;
  });
}

/**
 * Play a video: hand it to the user's browser, which is the one place it
 * reliably works, signed in and with their own history.
 *
 * NOT an inline `<iframe>`, which is what this started as: YouTube's embedded
 * player requires a valid HTTP `Referer`, and a packaged Tauri app serves the
 * UI from `tauri://localhost`, which cannot supply one — every embed returns
 * "Error 153: Video player configuration error" (tauri-apps/tauri#14422).
 * `referrerpolicy`, `?origin=` and `withGlobalTauri` are all dead ends
 * upstream, and so is an in-app webview window: measured, /embed/ as that
 * window's top-level document still returned 153.
 *
 * It plays inline perfectly well in `npm run dev`, where the page really is on
 * http://localhost — that's the trap. Any "simplification" back to an iframe
 * must be tested in the packaged build.
 */
function openVideo(id: string): void {
  const url = youTubeUrl(id);
  // Outside Tauri (the browser harness) there's no opener plugin, and a new
  // tab is the same gesture.
  if (isTauri()) void openUrl(url);
  else window.open(url, "_blank", "noopener");
}

/**
 * A video in a note: its thumbnail, with a play button over it.
 *
 * The wrapper is a `<span class="block">`, not a `<div>`: react-markdown puts a
 * link inside a `<p>`, and a div there is invalid nesting.
 */
export default function YouTubeEmbed({ id, title }: { id: string; title?: string }) {
  const { t } = useTranslation();
  // `maxresdefault` doesn't exist for every video and 404s; `hqdefault` always
  // does. Falling back on error costs nothing and looks the same when it works.
  const [thumb, setThumb] = useState(`https://i.ytimg.com/vi/${id}/maxresdefault.jpg`);
  const [noThumb, setNoThumb] = useState(false);

  return (
    <span className="my-4 block">
      <button
        type="button"
        onClick={() => openVideo(id)}
        title={title ?? t("notes.md.videoPlay")}
        aria-label={title ?? t("notes.md.videoPlay")}
        className="group relative block aspect-video w-full overflow-hidden rounded-lg bg-black"
      >
        {!noThumb && (
          <img
            src={thumb}
            alt=""
            // `cover` because hqdefault is 4:3 with black bars — letting it
            // fill a 16:9 box crops them off instead of framing them.
            className="h-full w-full object-cover"
            onError={() => {
              if (thumb.includes("maxresdefault")) setThumb(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`);
              else setNoThumb(true); // offline: the play button on black still works
            }}
          />
        )}
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex h-14 w-20 items-center justify-center rounded-xl bg-red-600/90 transition-colors group-hover:bg-red-600">
            <Play size={26} className="text-white" fill="currentColor" />
          </span>
        </span>
      </button>
    </span>
  );
}

/**
 * The `a` override for note previews: a bare YouTube URL becomes a player,
 * everything else renders as the link react-markdown would have produced.
 */
export function NoteLink({ href, children, ...rest }: ComponentPropsWithoutRef<"a">) {
  const id = href && isBareLink(href, linkText(children)) ? youTubeId(href) : null;
  if (id) return <YouTubeEmbed id={id} />;
  return <a href={href} {...rest}>{children}</a>;
}

/** The visible text of a link, flattened — an autolink's child is a plain
 *  string, and anything richer than that was never a bare URL. */
function linkText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children) && children.every((c) => typeof c === "string")) return children.join("");
  return "";
}
