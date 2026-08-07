import { parseCsv, toCsv } from "./csv";
import type { PastRead } from "./types";

// The persistent past-reads store's row shape and codec. Pure — the server owns the file, the
// client owns the panel and the export button, and both agree because they share this module.
//
// Deliberately GROUP-level: one rating and one note per book, no per-member breakdown. The
// feedback form collects per-member answers, but what survives a year later is "we read this,
// it went like this" — and a per-member store would need identities to stay stable across
// cycles, which a friend group's intake form does not guarantee.

export interface PastReadRow {
  title: string;
  author?: string;
  /** 1–5, fractional allowed (a seeded row carries the form's average). */
  rating?: number | null;
  /** One group note — what the group made of it. */
  note?: string;
  /** ISO timestamp; also the tiebreak when the file is hand-edited into a different order. */
  addedAt: string;
  /** Filled server-side from the books catalog (best-effort) so the panel shows real covers. */
  coverUrl?: string;
}

// `coverUrl` sits LAST so a header-less hand-typed file in the old five-column order still
// parses (addedAt stays at index 4).
const PAST_READS_HEADER = ["title", "author", "rating", "note", "addedAt", "coverUrl"];

/** The member name a group note is attributed to in the prompts (`historyLines` renders it). */
export const GROUP_NOTE_AUTHOR = "the group";

const NOTE_MAX = 300;
const clean = (s: unknown): string => (typeof s === "string" ? s.trim() : "");

/** Normalized title key — the store is keyed by title, like every other book identity here. */
export const pastReadKey = (title: string): string => title.trim().toLowerCase();

/** Coerce one row from anywhere (disk, request body) into a valid row, or null if unusable. */
export function toPastReadRow(input: unknown, fallbackAddedAt: string): PastReadRow | null {
  const r = (input ?? {}) as Record<string, unknown>;
  const title = clean(r.title);
  if (!title) return null;
  const ratingNum = typeof r.rating === "number" ? r.rating : Number(clean(r.rating));
  const rating = Number.isFinite(ratingNum) && ratingNum > 0 ? Math.min(5, Math.round(ratingNum * 10) / 10) : null;
  const author = clean(r.author);
  const note = clean(r.note).slice(0, NOTE_MAX);
  const addedAt = clean(r.addedAt) || fallbackAddedAt;
  const coverUrl = clean(r.coverUrl);
  return {
    title,
    ...(author ? { author } : {}),
    rating,
    ...(note ? { note } : {}),
    addedAt,
    ...(coverUrl ? { coverUrl } : {}),
  };
}

export function serializePastReadsCsv(rows: PastReadRow[]): string {
  return toCsv([
    PAST_READS_HEADER,
    ...rows.map((r) => [
      r.title,
      r.author ?? "",
      r.rating == null ? "" : String(r.rating),
      r.note ?? "",
      r.addedAt,
      r.coverUrl ?? "",
    ]),
  ]);
}

/**
 * Read the store file. Tolerant on purpose — this file is meant to be hand-editable, so a
 * missing column, a reordered header, or a junk rating must degrade rather than throw. Columns
 * are matched by NAME so an added column doesn't shift the others.
 */
export function parsePastReadsCsv(text: string): PastReadRow[] {
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim()));
  if (rows.length === 0) return [];
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  // No recognizable header → assume the canonical column order (someone typed the file by hand).
  const idx = header.includes("title")
    ? { title: col("title"), author: col("author"), rating: col("rating"), note: col("note"), addedAt: col("addedat"), coverUrl: col("coverurl") }
    : { title: 0, author: 1, rating: 2, note: 3, addedAt: 4, coverUrl: 5 };
  const body = header.includes("title") ? rows.slice(1) : rows;
  const at = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "") : "");

  const out: PastReadRow[] = [];
  const seen = new Set<string>();
  for (const r of body) {
    const row = toPastReadRow(
      {
        title: at(r, idx.title),
        author: at(r, idx.author),
        rating: at(r, idx.rating),
        note: at(r, idx.note),
        addedAt: at(r, idx.addedAt),
        coverUrl: at(r, idx.coverUrl),
      },
      "",
    );
    if (!row) continue;
    const key = pastReadKey(row.title);
    if (seen.has(key)) continue; // a hand-edited duplicate: first wins, like the upsert would
    seen.add(key);
    out.push(row);
  }
  return out;
}

/** Store rows as run history. A group note is attributed to "the group" so the existing
 * `historyLines` renderer shows it as an indented note line, exactly like a member's. */
export function pastReadsToHistory(rows: PastReadRow[]): PastRead[] {
  return rows.map((r) => ({
    title: r.title,
    ...(r.author ? { author: r.author } : {}),
    avgRating: r.rating ?? null,
    notes: r.note ? [{ member: GROUP_NOTE_AUTHOR, rating: r.rating ?? null, note: r.note }] : [],
  }));
}

/**
 * Past reads one run may carry. Beyond this the oldest entries stop being excluded — flagged in
 * NOTES; the clean fix is an uncapped exclusion list separate from the prompt's history block.
 */
export const HISTORY_CAP = 24;

/**
 * Merge a request's history with the store's, request first: a run loaded from a file carries
 * the history it was computed with, and that is fresher context than a row typed months ago.
 * Deduped by title, then capped at `HISTORY_CAP`.
 */
export function mergeHistory(
  requestHistory: PastRead[] | undefined,
  storeHistory: PastRead[],
  cap: number = HISTORY_CAP,
): { history: PastRead[]; dropped: number } {
  const merged: PastRead[] = [];
  const seen = new Set<string>();
  for (const h of [...(requestHistory ?? []), ...storeHistory]) {
    const key = pastReadKey(h.title);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(h);
  }
  return { history: merged.slice(0, cap), dropped: Math.max(0, merged.length - cap) };
}
