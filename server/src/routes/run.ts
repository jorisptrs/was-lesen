import type { Request, Response } from "express";
import type { RunRequest, SseEvent } from "@sb/shared";
import { config } from "../config";
import { normalizePace, resolveMembers, resolveQuality, resolveRunHistory } from "../domain/request";
import { pastReadsHistory } from "../pastReadsStore";
import { runPipeline } from "../pipeline/orchestrator";
import { acquireRunSlot, checkRateLimit, releaseRunSlot } from "../ratelimit/rateLimiter";
import { openSse } from "../sse/channel";


/**
 * POST /api/run → SSE stream. Rate limit, the effort/passphrase gate, and the concurrency cap
 * all run BEFORE the stream opens, so 400/403/429/503 are ordinary HTTP responses. Once the
 * stream is open, everything is an SSE event. The run slot is always released in `finally`.
 */
export async function handleRun(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as RunRequest;

  const members = resolveMembers(body);
  if (members.length === 0) {
    res.status(400).json({ error: "Provide at least one member (via `members` or `membersText`)." });
    return;
  }

  const rl = checkRateLimit(req.ip ?? "unknown");
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retryAfter));
    res.status(429).json({ error: `Rate limit reached (${config.RUN_RATE_LIMIT_PER_HOUR}/hour). Try again in ${rl.retryAfter}s.` });
    return;
  }

  // No effort gate any more: the route only exists on a machine with a `claude` login — i.e.
  // the organizer's own laptop, spending their own subscription. There is nobody to guard it
  // from. (Presets never yield "max" anyway; only a hand-made request can.)
  const { model, effort } = resolveQuality(body, config.ANTHROPIC_EFFORT);
  const pace = normalizePace(body.pace);
  const soloMode = body.soloMode ?? members.length <= 1;

  if (!acquireRunSlot()) {
    res.status(503).json({ error: "Too many runs in progress — try again in a moment." });
    return;
  }

  // Abort the run if the CLIENT disconnects. Use res "close" (not req "close": for a buffered
  // POST body, req "close" fires as soon as the body is read, which would abort our own run).
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  const sse = openSse<SseEvent>(res);
  try {
    await runPipeline(
      {
        members,
        constraints: body.constraints,
        pace,
        effort,
        model,
        soloMode,
        history: resolveRunHistory(body, pastReadsHistory()),
      },
      sse.send,
      controller.signal,
    );
  } catch (err) {
    if (!controller.signal.aborted) {
      sse.send({
        type: "error",
        stage: null,
        code: "internal_error",
        message: err instanceof Error ? err.message : "Unknown error",
        retryable: false,
      });
    }
  } finally {
    sse.close();
    releaseRunSlot();
  }
}
