// Contact avatar: shows a photo if present, otherwise the person's initials on
// a tinted circle. Shared by the People view and the PeoplePanel link widget.

/** Han, Hiragana/Katakana, and Hangul — scripts written without word spaces. */
const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;

/**
 * Initials for the avatar circle.
 *
 * `[...str]` iterates by code point, not UTF-16 code unit — indexing with [0]
 * splits a surrogate pair and renders a lone `` for names starting outside
 * the BMP (rare Han in plane 2, for instance).
 *
 * CJK names have no spaces, so the Latin "first letter of first and last word"
 * rule would return the whole name. The convention there is the surname
 * character alone, which for Chinese is the leading character.
 */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";

  if (parts.length === 1) {
    const chars = [...parts[0]];
    if (CJK.test(parts[0])) return chars[0];
    return chars.slice(0, 2).join("").toUpperCase();
  }

  const first = [...parts[0]][0];
  const last = [...parts[parts.length - 1]][0];
  // A CJK name has no casing; render its initials as-is. Test the chosen
  // initials, not the whole name: "Alice 王 Smith" is mixed, and testing the
  // whole string would wrongly lowercase the Latin "A". If either initial is
  // CJK we keep both characters uncased; otherwise uppercase (Latin convention).
  if (CJK.test(first) || CJK.test(last)) return first + last;
  return (first + last).toUpperCase();
}

export function Avatar({ name, photo, size = 36 }: { name: string; photo?: string | null; size?: number }) {
  if (photo) {
    return <img src={photo} alt="" className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />;
  }
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full bg-blue-100 font-medium text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
    >
      {initials(name)}
    </div>
  );
}
