import type { Request, Response } from "express";
import type { Effort, RunRequest } from "@sb/shared";
import { config } from "../config";
import { constantTimeEqual } from "../domain/auth";
import { normalizePace, resolveHistory, resolveMembers, resolveQuality } from "../domain/request";
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

  const { model, effort } = resolveQuality(body, config.ANTHROPIC_EFFORT);
  if (effort === "max" && !constantTimeEqual(body.maxEffortPassphrase, config.MAX_EFFORT_PASSPHRASE)) {
    res.status(403).json({ error: "Effort 'max' requires a valid passphrase." });
    return;
  }

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

  const sse = openSse(req, res);
  try {
    await runPipeline(
      { members, constraints: body.constraints, pace, effort, model, soloMode, history: resolveHistory(body) },
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
