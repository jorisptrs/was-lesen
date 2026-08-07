import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, Response } from "express";
import type { NormalizeEvent } from "@sb/shared";
import { ClaudeError, structuredCall } from "../claude/client";
import { NORMALIZE_LINE_JSON_SCHEMA, NormalizeLineSchema } from "../claude/schemas";
import { config } from "../config";
import {
  normalizeKeys,
  normalizeTotal,
  reconcileNormalize,
  renderNormalizeUser,
  resolveNormalizeInput,
} from "../domain/normalize";
import { checkRateLimit } from "../ratelimit/rateLimiter";
import { openSse } from "../sse/channel";

const here = dirname(fileURLToPath(import.meta.url));
const NORMALIZE_SYSTEM = readFileSync(resolve(here, "../prompts/normalize.system.md"), "utf8").trim();

/**
 * POST /api/normalize → SSE stream. Stage 0: clean up raw human-typed intake text via one Claude
 * call. Body `{entries: string[], paragraphs?: string[], rules?: string[]}`:
 *  - `entries` (book-list strings) → `{original, kind, title, author, authorFromText}` each;
 *  - `paragraphs` / `rules` → the same texts with pleasantries/meta removed, in order.
 *
 * It streams because it is SLOW: a 9-member CSV took 62–75s of blocking spinner (M34 notes).
 * `normalize_progress` ticks off the growing output file, then exactly one terminal event —
 * `normalize_result` or `normalize_error`. Failures are the client's cue to proceed with the raw
 * strings: this endpoint is a nice-to-have, never a gate.
 *
 * Granularity caveat (measured, M35): normalize lines are SHORT, so ~70 of them still fit in one
 * response and the agent writes the whole file in a single turn — the count then jumps 0 → n at
 * the end rather than climbing. Stage 3 ticks properly because its two-paragraph summaries can't
 * fit one response. So the count is a real signal, not a smooth one, and the client also shows
 * elapsed time. Forcing groups here would buy a nicer bar for several extra turns of latency.
 */
export async function handleNormalize(req: Request, res: Response): Promise<void> {
  const input = resolveNormalizeInput(req.body);
  const total = normalizeTotal(input);
  // Validation and rate-limiting happen BEFORE the stream opens, so these stay ordinary HTTP
  // statuses — once the stream is open, every outcome is an SSE event.
  if (total === 0) {
    res.status(400).json({ error: "Provide non-empty `entries`, `paragraphs`, or `rules` arrays." });
    return;
  }

  // Own bucket: a few cheap CSV-import cleanups must not consume the expensive run budget.
  const rl = checkRateLimit(`normalize:${req.ip ?? "unknown"}`, 60);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retryAfter));
    res.status(429).json({ error: `Rate limit reached. Try again in ${rl.retryAfter}s.` });
    return;
  }

  // Abort the CLI call when the organizer closes the tab mid-import. Use res "close", not req
  // "close": for a buffered POST body the latter fires as soon as the body is read.
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  const sse = openSse<NormalizeEvent>(res);
  // Announce the size immediately: the first real tick can be 40s away (see below), and "0/72"
  // from the first frame is what tells the organizer the request was understood.
  sse.send({ type: "normalize_progress", done: 0, total });
  try {
    const lines = await structuredCall({
      system: NORMALIZE_SYSTEM,
      user: renderNormalizeUser(input),
      model: config.NORMALIZE_MODEL, // optional stronger model; undefined → ANTHROPIC_MODEL
      effort: config.ANTHROPIC_EFFORT,
      lineSchema: NORMALIZE_LINE_JSON_SCHEMA,
      parseLine: (raw) => NormalizeLineSchema.parse(raw),
      keyOf: (l) => `${l.type}:${l.index}`,
      expectedKeys: normalizeKeys(input),
      followUpUser: (missing) =>
        `${renderNormalizeUser(input, new Set(missing))}\n\n(Process ONLY these items, keeping the numbering shown.)`,
      expectedLines: total,
      // Capped at the total: the recovery call's offset can push the raw count past it, and a
      // counter reading "94/88" reads like a bug to the person watching it.
      onLines: (done) => sse.send({ type: "normalize_progress", done: Math.min(done, total), total }),
      signal: controller.signal,
    });

    const { result, missed } = reconcileNormalize(input, lines);
    if (missed > 0) console.warn(`[normalize] ${missed} entr(ies) had no line — left as typed`);
    sse.send({ type: "normalize_result", result });
  } catch (err) {
    if (!controller.signal.aborted) {
      const message = err instanceof ClaudeError ? err.message : "Normalization failed.";
      sse.send({ type: "normalize_error", message });
    }
  } finally {
    sse.close();
  }
}
