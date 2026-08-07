import type { Request, Response } from "express";
import { enrichPastReadsCovers, listPastReads, removePastRead, upsertPastReads } from "../pastReadsStore";

// The past-reads store's API. Organizer-only for free: the app-wide gate locks every /api path
// except health/current/auth-check, so a viewer of the published map can never read the group's
// reading history — and on a deployed host the store simply doesn't exist.

const MAX_ROWS_PER_REQUEST = 200;

/** GET /api/past-reads → every stored book. Covers for hand-edited rows fill in the
 * background — the panel must not stall behind a throttled books API on boot. */
export function handleListPastReads(_req: Request, res: Response): void {
  const rows = listPastReads();
  void enrichPastReadsCovers();
  res.json({ rows });
}

/**
 * POST /api/past-reads → upsert one row or many (`{row}` or `{rows}`), keyed by title. Used by
 * the panel's add form and by seeding from a feedback-form CSV. Always answers with the whole
 * store, so the client never has to guess what the merge did.
 */
export async function handleSavePastReads(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as { row?: unknown; rows?: unknown };
  const inputs = Array.isArray(body.rows) ? body.rows : body.row ? [body.row] : [];
  if (inputs.length === 0) {
    res.status(400).json({ error: "Provide a `row` or a `rows` array." });
    return;
  }
  upsertPastReads(inputs.slice(0, MAX_ROWS_PER_REQUEST));
  // Awaited on purpose: the row the panel gets back should already wear its cover (cache-first,
  // so a re-import costs nothing; a fresh add is one books-API lookup).
  await enrichPastReadsCovers();
  res.json({ rows: listPastReads() });
}

/** DELETE /api/past-reads?title=… → drop one book. */
export function handleDeletePastRead(req: Request, res: Response): void {
  const title = typeof req.query.title === "string" ? req.query.title : "";
  if (!title.trim()) {
    res.status(400).json({ error: "Provide the `title` to remove." });
    return;
  }
  res.json({ rows: removePastRead(title) });
}
