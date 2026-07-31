import type { Request, Response } from "express";
import { validateSavedRun } from "@sb/shared";
import { config } from "../config";
import { getPublishedRun, publishRun } from "../publishedRun";

/** POST /api/publish — make this run THE map the main page shows (gated by the app
 * passphrase middleware; the group browses it and votes in person). With PUBLISH_TARGET set
 * (the laptop workflow), the run is forwarded to the hosted app instead — run locally on the
 * subscription, appear online in one click. */
export async function handlePublish(req: Request, res: Response): Promise<void> {
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

  if (config.PUBLISH_TARGET) {
    try {
      const remote = await fetch(`${config.PUBLISH_TARGET.replace(/\/$/, "")}/api/publish`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.PUBLISH_PASSPHRASE ? { "X-App-Passphrase": config.PUBLISH_PASSPHRASE } : {}),
        },
        body: JSON.stringify({ run }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!remote.ok) {
        const detail = (await remote.json().catch(() => null)) as { error?: string } | null;
        res.status(502).json({ error: `Remote publish failed (${remote.status}): ${detail?.error ?? "unknown"}` });
        return;
      }
      const data = (await remote.json()) as { publishedAt?: string };
      res.json({ ok: true, publishedAt: data.publishedAt, publishedTo: config.PUBLISH_TARGET });
      return;
    } catch (err) {
      res.status(502).json({ error: `Could not reach ${config.PUBLISH_TARGET}: ${err instanceof Error ? err.message : "network error"}` });
      return;
    }
  }

  const published = publishRun(run);
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

/** GET /api/auth-check — a gated no-op: 200 means the caller's passphrase works (or the
 * gate is off). The client probes this on boot to decide locked vs organizer view. */
export function handleAuthCheck(_req: Request, res: Response): void {
  res.json({ ok: true });
}
