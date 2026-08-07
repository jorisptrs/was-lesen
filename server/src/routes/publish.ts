import type { Request, Response } from "express";
import { validateSavedRun } from "@sb/shared";
import { claudeAvailable } from "../claude/available";
import { config } from "../config";
import { getPublishedRun, publishRun } from "../publishedRun";
import { checkRateLimit } from "../ratelimit/rateLimiter";

/**
 * POST /api/publish — make this run THE map the main page shows. On the laptop (PUBLISH_TARGET
 * set) it also forwards to the hosted app, so a run computed on the subscription appears online
 * in one click.
 *
 * Deliberately OPEN — no credential anywhere in this app. The deployment is meant to need zero
 * configuration, and the accepted trade is that a link-holder could replace the map, which the
 * organizer undoes by republishing. Nothing here leaks or costs money; it's rate-limited so it
 * can't be hammered.
 */
export async function handlePublish(req: Request, res: Response): Promise<void> {
  const rl = checkRateLimit(`publish:${req.ip ?? "unknown"}`, 30);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retryAfter));
    res.status(429).json({ error: `Too many publishes — try again in ${rl.retryAfter}s.` });
    return;
  }

  let run;
  try {
    run = validateSavedRun((req.body ?? {}).run);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Invalid run payload." });
    return;
  }
  if (run.scored.books.length === 0) {
    res.status(400).json({ error: "This run has no books to publish." });
    return;
  }

  // Keep a local copy ALWAYS, even when forwarding. Without this the laptop is the one machine
  // that never keeps what it produced: `publish` returned early on the remote path, the hosted
  // slot lives on an ephemeral disk, and a map could exist in exactly one place. Writing here
  // first also means a failed forward still leaves the run recoverable.
  const published = publishRun(run);

  // Only the WORKSHOP forwards. Keying this on `claudeAvailable` too makes the two roles
  // mutually exclusive by construction — a host that somehow inherited a PUBLISH_TARGET would
  // otherwise relay a publish straight back out, which is a loop, not a feature.
  if (config.PUBLISH_TARGET && claudeAvailable()) {
    try {
      const remote = await fetch(`${config.PUBLISH_TARGET.replace(/\/$/, "")}/api/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!remote.ok) {
        const detail = (await remote.json().catch(() => null)) as { error?: string } | null;
        res.status(502).json({ error: `Remote publish failed (${remote.status}): ${detail?.error ?? "unknown"}` });
        return;
      }
      const data = (await remote.json()) as { publishedAt?: string };
      res.json({ ok: true, publishedAt: data.publishedAt ?? published.publishedAt, publishedTo: config.PUBLISH_TARGET });
      return;
    } catch (err) {
      res.status(502).json({ error: `Could not reach ${config.PUBLISH_TARGET}: ${err instanceof Error ? err.message : "network error"}` });
      return;
    }
  }

  res.json({ ok: true, publishedAt: published.publishedAt });
}

/** GET /api/current — the published run everyone sees on the main page. Open (no gate), so
 * the payload is REDACTED to what the viewer UI actually renders: the scored map, member
 * names, and pace. Raw intake paragraphs (incl. beliefs-to-stress-test), constraints, and
 * past feedback quotes never leave the server on the open endpoint — members wrote those for
 * the organizer and the model, not for anyone holding the link. */
export function handleCurrent(_req: Request, res: Response): void {
  const published = getPublishedRun();
  if (!published) {
    res.status(404).json({ error: "Nothing published yet." });
    return;
  }
  const { run } = published;
  const redacted = {
    app: run.app,
    version: run.version,
    savedAt: run.savedAt,
    input: { membersText: "", constraints: "", pace: run.input.pace },
    members: run.members,
    scored: run.scored,
  };
  res.json({ run: redacted, publishedAt: published.publishedAt });
}

