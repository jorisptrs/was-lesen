import type { BookRef } from "@sb/shared";

/**
 * Parse a single free-text book reference into `{ title, author? }`.
 * Recognises "Title — Author" (em/en/hyphen dash, space-padded) and "Title by Author".
 * Returns null only for blank input.
 */
export function parseBookRef(raw: string): BookRef | null {
  const s = raw.trim().replace(/\s+/g, " ");
  if (!s) return null;

  for (const sep of [" — ", " – ", " - "]) {
    const i = s.indexOf(sep);
    if (i > 0) {
      const author = s.slice(i + sep.length).trim();
      return { title: s.slice(0, i).trim(), ...(author ? { author } : {}) };
    }
  }

  const byMatch = s.match(/^(.*\S)\s+by\s+(\S.*)$/i);
  if (byMatch) return { title: byMatch[1]!.trim(), author: byMatch[2]!.trim() };

  return { title: s };
}

/** Parse a semicolon- or newline-separated list of book references. */
export function parseBookList(raw: string): BookRef[] {
  return raw
    .split(/[;\n]/)
    .map(parseBookRef)
    .filter((b): b is BookRef => b !== null && b.title.length > 0);
}

// Title identity lives in @sb/shared so the client can key books identically (the suggest bar
// rejects a duplicate before spending a call on it). Re-exported here so existing importers of
// `domain/bookref` are unaffected.
export { normalizeTitle, titleKey } from "@sb/shared";
