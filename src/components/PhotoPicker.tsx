// Avatar that doubles as a photo upload control for the person editor.
//
// The photo is stored inline on the `people` row as a data URI (vCard PHOTO),
// so it must stay small: `listPeople` selects *, and a raw phone photo would
// mean megabytes of base64 re-read on every list render. Every image is
// therefore center-cropped and re-encoded to a 256px JPEG before it is stored.

import { useRef, useState } from "react";
import { Camera, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Avatar } from "./Avatar";
import { decode, encodeJpeg, IMAGE_ACCEPT as ACCEPT } from "../lib/images";

/** Longest edge of the stored square, and the JPEG quality used for it. */
const SIZE = 256;
const QUALITY = 0.8;

/** Center-crop to a square and re-encode as a JPEG data URI. */
async function toDataUri(file: File): Promise<string> {
  const bitmap = await decode(file);
  try {
    const edge = Math.min(bitmap.width, bitmap.height);
    return encodeJpeg(bitmap, SIZE, SIZE, {
      x: (bitmap.width - edge) / 2,
      y: (bitmap.height - edge) / 2,
      w: edge,
      h: edge,
    }, QUALITY);
  } finally {
    bitmap.close();
  }
}

export function PhotoPicker({
  name, value, onChange, size = 56,
}: {
  name: string;
  value: string;
  onChange: (photo: string) => void;
  size?: number;
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState(false);

  async function pick(file: File | undefined) {
    if (!file) return;
    setError(false);
    try {
      onChange(await toDataUri(file));
    } catch {
      setError(true);
    }
  }

  return (
    <div className="shrink-0">
      <div className="group relative" style={{ width: size, height: size }}>
        <Avatar name={name} photo={value} size={size} />
        <button
          type="button"
          onClick={() => input.current?.click()}
          aria-label={t("people.changePhoto")}
          title={t("people.changePhoto")}
          className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 focus:outline-none"
        >
          <Camera size={Math.round(size * 0.32)} />
        </button>
        {value && (
          <button
            type="button"
            onClick={() => { setError(false); onChange(""); }}
            aria-label={t("people.removePhoto")}
            title={t("people.removePhoto")}
            // Same reveal-on-hover/focus pattern as the camera overlay above, so
            // the button is also reachable by keyboard rather than mouse-only.
            className="absolute -right-1 -top-1 rounded-full bg-neutral-800 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 focus:outline-none"
          >
            <Trash2 size={12} />
          </button>
        )}
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            void pick(e.target.files?.[0]);
            // Clear so re-picking the same file fires onChange again.
            e.target.value = "";
          }}
        />
      </div>
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{t("people.photoError")}</p>}
    </div>
  );
}
