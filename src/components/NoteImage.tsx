// Renders `![alt](sbimg:<id>)` in the note preview by loading the row from
// `note_images` and handing the <img> an object URL.
//
// The cache is module-scoped, so toggling between edit and preview — or
// revisiting a note — doesn't re-read the bytes out of SQLite each time. Object
// URLs are revoked in `releaseNoteImages`, called when the notes view unmounts;
// they are NOT revoked per-component, because the same image is usually
// remounted moments later by the very next preview toggle.

import { useEffect, useState } from "react";
import { ImageOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { defaultUrlTransform } from "react-markdown";
import { getNoteImage } from "../db";
import { toObjectUrl } from "../lib/images";

export const SBIMG = "sbimg:";

/**
 * react-markdown sanitizes every URL through `defaultUrlTransform`, which
 * blanks any protocol outside http/https/mailto/xmpp/irc — `sbimg:` included.
 * The reference then reaches this component as `src=""`, and the browser draws
 * the broken-image box with the alt text in it, which looks exactly like the
 * image "didn't load" rather than like it was stripped.
 *
 * Everything else keeps the default sanitizer: `sbimg:` resolves to bytes this
 * app wrote itself, whereas a `javascript:` URL in a note must still be killed.
 */
export function noteUrlTransform(url: string, key: string, node: { tagName?: string }): string {
  if (url.startsWith(SBIMG) && key === "src" && node.tagName === "img") return url;
  return defaultUrlTransform(url);
}

type Cached = { url: string; width: number; height: number };

const cache = new Map<string, Cached>();
const inflight = new Map<string, Promise<Cached | null>>();

async function load(id: string): Promise<Cached | null> {
  const hit = cache.get(id);
  if (hit) return hit;
  // Two <img>s for the same id (a note referencing one image twice) must not
  // each decode and leak a separate object URL.
  const running = inflight.get(id);
  if (running) return running;

  const p = (async () => {
    try {
      const img = await getNoteImage(id);
      if (!img) return null;
      // The bytes arrive as a Blob from the Worker, so an object URL is
      // made directly — no base64 round-trip through the DOM.
      const entry = { url: URL.createObjectURL(img.blob), width: img.width, height: img.height };
      cache.set(id, entry);
      return entry;
    } catch {
      return null;
    } finally {
      inflight.delete(id);
    }
  })();
  inflight.set(id, p);
  return p;
}

/** Drop every cached object URL. Called when the notes view unmounts. */
export function releaseNoteImages(): void {
  for (const { url } of cache.values()) URL.revokeObjectURL(url);
  cache.clear();
}

/** Newly-stored images go straight into the cache, so the first preview after
 *  inserting one doesn't round-trip to SQLite for bytes we already hold. */
export function primeNoteImage(id: string, mime: string, data: string, width: number, height: number): void {
  if (cache.has(id)) return;
  cache.set(id, { url: toObjectUrl(mime, data), width, height });
}

export default function NoteImage({ src, alt }: { src?: string; alt?: string }) {
  const { t } = useTranslation();
  const id = src?.startsWith(SBIMG) ? src.slice(SBIMG.length) : null;
  const [entry, setEntry] = useState<Cached | null>(() => (id ? cache.get(id) ?? null : null));
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!id || cache.has(id)) return;
    let live = true;
    void load(id).then((e) => {
      if (!live) return;
      if (e) setEntry(e);
      else setMissing(true);
    });
    return () => { live = false; };
  }, [id]);

  // A plain URL in a note (pasted from the web) still renders as a normal image.
  // An empty src means the sanitizer rejected the URL — show the same chip as a
  // missing image rather than the browser's broken-image box, which reads as a
  // load failure and hides the fact that the link was stripped on purpose.
  if (!id && src) return <img src={src} alt={alt ?? ""} className="h-auto max-w-full rounded" />;

  if (missing || !id) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded border border-neutral-200 px-2 py-1 text-xs text-neutral-400 dark:border-neutral-700">
        <ImageOff size={13} /> {alt || t("notes.md.imageMissing")}
      </span>
    );
  }

  if (!entry) {
    // Placeholder while the row loads. No dimensions are known yet, so this is
    // a fixed box rather than a correctly-shaped one.
    return <span className="block h-32 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />;
  }

  return (
    <img
      src={entry.url}
      alt={alt ?? ""}
      // Intrinsic size from the row: the browser reserves the right box before
      // decoding, so a long note doesn't jump as each image lands.
      width={entry.width}
      height={entry.height}
      className="h-auto max-w-full rounded"
    />
  );
}
