/**
 * Term-based text ranking, shared by the client's global search bar, the
 * Worker's search endpoints, and the assistant's search tools.
 *
 * This lives in one place on purpose. CLAUDE.md records that these helpers were
 * kept together specifically because two copies would drift on the exact
 * phrasing bug they exist to prevent: matching a query as ONE substring means
 * `%lunch with Alex meeting%` finds nothing when the row is "Lunch with Alex",
 * and the assistant then wrongly reports the item doesn't exist. Splitting the
 * ranking between a client copy and a server copy would recreate that hazard at
 * a worse scale — so both sides import from here.
 */

export function queryTerms(query: string): string[] {
  return query.split(/\s+/).map((t) => t.replace(/"/g, "")).filter(Boolean);
}

/**
 * Escape the LIKE wildcard characters so a user's `%` or `_` is matched
 * literally. Pair with `ESCAPE '\'` on the LIKE clause. Backslash is the escape
 * char, so it must be escaped first.
 */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

/**
 * SQL prefilter matching ANY term, so the JS ranking below has candidates to
 * work with without loading the whole table.
 */
export function anyTermClause(
  terms: string[],
  columns: string[],
): { clause: string; params: string[] } {
  const one = `(${columns.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(" OR ")})`;
  return {
    clause: `(${terms.map(() => one).join(" OR ")})`,
    params: terms.flatMap((t) => columns.map(() => `%${escapeLike(t)}%`)),
  };
}

/**
 * Rank rows against a query: every term must match, else the best partial
 * matches closest-first with `partial` set.
 *
 * `partial` matters to the assistant, which must confirm a loose match before
 * acting on it — this is what protects a delete from firing on a fuzzy hit.
 */
export function matchQuery<T>(
  rows: T[],
  query: string,
  fields: (row: T) => (string | null | undefined)[],
): { rows: T[]; partial: boolean } {
  const terms = queryTerms(query.trim().toLowerCase());
  if (terms.length === 0) return { rows, partial: false };

  const scored = rows.map((row) => {
    const hay = fields(row).filter(Boolean).join(" ").toLowerCase();
    return { row, hits: terms.filter((t) => hay.includes(t)).length };
  });

  const strict = scored.filter((s) => s.hits === terms.length);
  if (strict.length > 0) return { rows: strict.map((s) => s.row), partial: false };

  const loose = scored.filter((s) => s.hits > 0).sort((a, b) => b.hits - a.hits);
  return { rows: loose.map((s) => s.row), partial: loose.length > 0 };
}
