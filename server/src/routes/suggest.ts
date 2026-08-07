import type { Request, Response } from "express";
import type { CheckRequest, PendingBook, RescoreRequest, ScoredCard, SuggestEvent } from "@sb/shared";
import { ClaudeError } from "../claude/client";
import { config } from "../config";
import { resolveMembers, resolveQuality, resolveRunHistory } from "../domain/request";
import { pastReadsHistory } from "../pastReadsStore";
import { SuggestRefused, checkCandidate, rescoreWithPending } from "../pipeline/suggest";
import { acquireRunSlot, checkRateLimit, releaseRunSlot } from "../ratelimit/rateLimiter";
import { openSse } from "../sse/channel";

const MAX_BOOKS = 60; // a map is ≤25; the cap bounds what one request can make us re-score
const MAX_PENDING = 20;

const strings = (v: unknown, cap: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, cap) : [];

/**
 * POST /api/suggest/check — verify ONE typed title against the books catalog. No Claude, so a
 * name called out in the room costs ~a second; the obvious refusals (already on the map, already
 * read, misspelt) happen here rather than after a scoring call.
 */
export async function handleSuggestCheck(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as CheckRequest;
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    res.status(400).json({ error: "Type a book title." });
    return;
  }
  const rl = checkRateLimit(`suggest:${req.ip ?? "unknown"}`, 120);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retryAfter));
    res.status(429).json({ error: `Too many lookups — try again in ${rl.retryAfter}s.` });
    return;
  }

  const controller = new AbortController();
  res.on("close", () => controller.abort());
  try {
    const book = await checkCandidate(
      {
        title,
        author: typeof body.author === "string" ? body.author.trim() : "",
        nominatedBy: typeof body.nominatedBy === "string" && body.nominatedBy.trim() ? body.nominatedBy.trim() : null,
        members: resolveMembers(body),
        history: resolveRunHistory(body, pastReadsHistory()),
        books: Array.isArray(body.books) ? (body.books.slice(0, MAX_BOOKS) as ScoredCard[]) : [],
        pendingTitles: strings(body.pendingTitles, MAX_PENDING),
      },
      controller.signal,
    );
    res.json({ book });
  } catch (err) {
    if (err instanceof SuggestRefused) {
      res.status(409).json({ error: err.message, code: err.code });
      return;
    }
    res.status(502).json({ error: err instanceof Error ? err.message : "Could not look that book up." });
  }
}

/**
 * POST /api/suggest/rescore → SSE. Score the whole pool (map + pending) in one Stage-3 call,
 * re-select, re-place. Minutes of work, so it streams.
 *
 * Gates run BEFORE the stream opens (so they stay ordinary HTTP statuses) and include the RUN
 * SLOT: this is a full scoring pass on the same laptop a run may be using. Released in
 * `finally`, always.
 */
export async function handleSuggestRescore(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as RescoreRequest;
  const books = Array.isArray(body.books) ? (body.books.slice(0, MAX_BOOKS) as ScoredCard[]) : [];
  const pending = Array.isArray(body.pending) ? (body.pending.slice(0, MAX_PENDING) as PendingBook[]) : [];
  const members = resolveMembers(body);

  if (members.length === 0) {
    res.status(400).json({ error: "This run has no members to score against." });
    return;
  }
  if (books.length === 0) {
    res.status(400).json({ error: "Run the map first — books are added to an existing map." });
    return;
  }
  if (pending.length === 0) {
    res.status(400).json({ error: "Add at least one book first." });
    return;
  }

  const rl = checkRateLimit(`suggest:${req.ip ?? "unknown"}`, 120);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retryAfter));
    res.status(429).json({ error: `Too many requests — try again in ${rl.retryAfter}s.` });
    return;
  }
  if (!acquireRunSlot()) {
    res.status(503).json({ error: "A run is using the machine — try again in a moment." });
    return;
  }

  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  const sse = openSse<SuggestEvent>(res);
  try {
    const { model, effort } = resolveQuality(body, config.ANTHROPIC_EFFORT);
    const outcome = await rescoreWithPending(
      {
        members,
        constraints: body.constraints,
        history: resolveRunHistory(body, pastReadsHistory()),
        effort,
        model,
        books,
        clusters: Array.isArray(body.clusters) ? body.clusters : [],
        pending,
      },
      sse.send,
      controller.signal,
    );
    sse.send({
      type: "suggest_result",
      books: outcome.result.books,
      clusters: outcome.result.clusters,
      coverage: outcome.result.coverage,
      selection: outcome.result.selection,
      addedIds: outcome.addedIds,
      message: outcome.message,
    });
  } catch (err) {
    if (!controller.signal.aborted) {
      const refused = err instanceof SuggestRefused;
      sse.send({
        type: "suggest_error",
        code: refused ? err.code : err instanceof ClaudeError ? err.code : "internal_error",
        message:
          refused || err instanceof ClaudeError
            ? (err as Error).message
            : err instanceof Error
              ? err.message
              : "Could not rescore.",
      });
    }
  } finally {
    sse.close();
    releaseRunSlot();
  }
}
