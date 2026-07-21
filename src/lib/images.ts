// Image decoding/encoding shared by the person photo picker and note images.
//
// Both paths re-encode to JPEG rather than storing the original: the bytes end
// up as base64 TEXT in SQLite, where a 5MB phone photo is a 6.7MB string that
// has to cross the plugin's JSON bridge on every read.

/** Formats WebKit decodes. HEIC is deliberately absent — it fails to decode. */
export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

/** Longest edge of a note image. Wide enough for a retina screenshot at the
 *  editor's max width, small enough that a photo lands in the low hundreds of KB. */
const NOTE_MAX_EDGE = 1600;
const NOTE_QUALITY = 0.82;

/**
 * Decode a file to a bitmap with EXIF rotation applied — without
 * `imageOrientation`, every photo taken on a phone lands sideways.
 */
export function decode(file: File | Blob): Promise<ImageBitmap> {
  return createImageBitmap(file, { imageOrientation: "from-image" });
}

/**
 * Draw `bitmap` into a canvas of the given size and re-encode as JPEG.
 *
 * The canvas is filled white first because JPEG has no alpha channel —
 * otherwise a transparent PNG re-encodes with black behind it.
 */
export function encodeJpeg(
  bitmap: ImageBitmap,
  w: number, h: number,
  src: { x: number; y: number; w: number; h: number },
  quality: number,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, src.x, src.y, src.w, src.h, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", quality);
}

export type EncodedImage = { mime: string; data: string; width: number; height: number };

/**
 * Scale a file down to fit `NOTE_MAX_EDGE` (never up — a small screenshot
 * stays its own size) and return the base64 payload without the `data:` prefix,
 * which is what `note_images` stores.
 */
export async function encodeNoteImage(file: File | Blob): Promise<EncodedImage> {
  const bitmap = await decode(file);
  try {
    const scale = Math.min(1, NOTE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const uri = encodeJpeg(
      bitmap, width, height,
      { x: 0, y: 0, w: bitmap.width, h: bitmap.height },
      NOTE_QUALITY,
    );
    return { mime: "image/jpeg", data: uri.slice(uri.indexOf(",") + 1), width, height };
  } finally {
    bitmap.close();
  }
}

/** Rebuild a displayable object URL from a stored row. Object URLs beat data
 *  URIs here: the base64 never has to round-trip through the DOM as an attribute. */
export function toObjectUrl(mime: string, base64: string): string {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}
