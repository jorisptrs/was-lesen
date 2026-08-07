import { readFileSync } from "node:fs";
import pLimit from "p-limit";
import {
  type PastRead,
  type PastReadRow,
  parsePastReadsCsv,
  pastReadKey,
  pastReadsToHistory,
  serializePastReadsCsv,
  toPastReadRow,
} from "@sb/shared";
import { verifyCandidate } from "./pipeline/stage2";
import { shortId } from "./util/ids";
import { cacheFile } from "./util/paths";
import { persistedFile } from "./util/persist";

// The group's reading history, kept on the ORGANIZER'S LAPTOP and never served to viewers (the
// passphrase gate covers /api/past-reads by default — only health/current/auth-check are open).
// It feeds every run's prompts and exclusions automatically, so the group stops re-reading books
// and Stage 3 keeps calibrating against what actually landed.
//
// CSV, not JSON, because the organizer should be able to open it in a spreadsheet, fix a title,
// and have the app pick that up — the format IS part of the feature.

export const PAST_READS_FILE = cacheFile("past-reads.csv");

let rows: PastReadRow[] = [];
let known = -1; // last logged row count, so a re-read doesn't spam the log
const file = persistedFile({ label: "past-reads", file: PAST_READS_FILE, serialize: () => serializePastReadsCsv(rows) });

/**
 * Re-read from disk on every access, unless one of our own writes is still queued. The file is
 * meant to be opened in a spreadsheet and fixed by hand; a cached-forever copy would silently
 * overwrite that edit on the next save. It is a few kB and read a handful of times per run —
 * far cheaper than a file watcher, and it has no stale window.
 */
function syncFromDisk(): void {
  if (file.hasPending()) return; // memory is ahead of disk — don't read our own changes away
  try {
    rows = parsePastReadsCsv(readFileSync(PAST_READS_FILE, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[past-reads] could not read the store — treating as empty:", err instanceof Error ? err.message : err);
    }
    rows = [];
  }
  if (rows.length !== known) {
    known = rows.length;
    console.log(`[past-reads] ${rows.length} book(s) in ${PAST_READS_FILE}`);
  }
}

export function listPastReads(): PastReadRow[] {
  syncFromDisk();
  return rows;
}

/** The store as run history — merged into `ResolvedRun.history` by the run/preview routes. */
export function pastReadsHistory(): PastRead[] {
  return pastReadsToHistory(listPastReads());
}

/**
 * Upsert by title. An existing row keeps its `addedAt` (when the group read it, not when the row
 * was last touched) and its fields are only overwritten by non-empty incoming ones — so
 * re-importing a feedback CSV can't blank a note the organizer typed by hand.
 */
export function upsertPastReads(inputs: unknown[]): PastReadRow[] {
  syncFromDisk();
  const now = new Date().toISOString();
  let changed = 0;
  for (const input of inputs) {
    const incoming = toPastReadRow(input, now);
    if (!incoming) continue;
    const i = rows.findIndex((r) => pastReadKey(r.title) === pastReadKey(incoming.title));
    if (i < 0) {
      rows.push(incoming);
    } else {
      const existing = rows[i]!;
      rows[i] = {
        ...existing,
        title: incoming.title, // adopt the incoming casing/spelling — the fresher spelling wins
        ...(incoming.author ? { author: incoming.author } : {}),
        ...(incoming.rating != null ? { rating: incoming.rating } : {}),
        ...(incoming.note ? { note: incoming.note } : {}),
      };
    }
    changed++;
  }
  if (changed) file.save();
  return rows;
}

// Books we already looked up this server lifetime — a no-match must not be retried on every
// panel fetch (the books APIs throttle). A reboot retries naturally.
const coverAttempted = new Set<string>();

/**
 * Fill missing covers (and absent authors) from the books catalog. Cache-first via the match
 * cache, so anything ever resolved before is free. Callers choose the latency contract: the
 * upsert route AWAITS it (an added book should come back wearing its cover), the list route
 * fires it in the background (a hand-edited row's cover lands on the next fetch rather than
 * stalling the panel behind a throttled books API).
 */
export async function enrichPastReadsCovers(): Promise<void> {
  const targets = rows.filter((r) => !r.coverUrl && !coverAttempted.has(pastReadKey(r.title)));
  if (targets.length === 0) return;
  for (const t of targets) coverAttempted.add(pastReadKey(t.title)); // claim before the awaits — no double lookups
  const limit = pLimit(4);
  const signal = new AbortController().signal; // never aborted: enrichment is tiny and best-effort
  let changed = 0;

  await Promise.all(
    targets.map((t) =>
      limit(async () => {
        const key = pastReadKey(t.title);
        try {
          const res = await verifyCandidate(
            { id: shortId("pr"), title: t.title, author: t.author ?? "", provenance: "organizer_add", nominatedBy: null },
            signal,
          );
          let book = res.book;
          // A typo'd author fails the strict confirmation ("Daniel Dennet" vs the catalog's
          // "Daniel C. Dennett") and would leave the cover missing forever. The group READ this
          // book — the title is certain — so retry title-only and adopt the COVER alone; the
          // organizer's typed author is their data and stays verbatim.
          if (!book?.coverUrl && t.author) {
            book = (
              await verifyCandidate(
                { id: shortId("pr"), title: t.title, author: "", provenance: "organizer_add", nominatedBy: null },
                signal,
              )
            ).book;
          }
          if (!book?.coverUrl) return;
          // Re-find by key: `rows` may have been re-read from disk while we were fetching.
          const row = rows.find((r) => pastReadKey(r.title) === key);
          if (!row || row.coverUrl) return;
          row.coverUrl = book.coverUrl;
          if (!row.author && book.author) row.author = book.author;
          changed++;
        } catch {
          // no cover — the hashed placeholder is the honest fallback
        }
      }),
    ),
  );
  if (changed) file.save();
}

/** Remove by title (the store's key). Returns the surviving rows. */
export function removePastRead(title: string): PastReadRow[] {
  syncFromDisk();
  const key = pastReadKey(title);
  const before = rows.length;
  rows = rows.filter((r) => pastReadKey(r.title) !== key);
  if (rows.length !== before) file.save();
  return rows;
}
