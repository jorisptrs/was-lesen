import type { Request, Response } from "express";
import { claudeAvailable } from "../claude/available";
import { config } from "../config";

/**
 * GET /api/health — open, and the client's capability probe on boot.
 *
 * `canRun` is the ONE thing that decides which app you get. True on the organizer's laptop
 * (a `claude` login is present, so runs are possible) → the full workspace. False on a host →
 * the read-only viewer, and those routes aren't even registered there. It replaced a passphrase
 * gate: what a machine can do is a fact about the machine, not a secret to be typed in.
 */
export function handleHealth(_req: Request, res: Response): void {
  const canRun = claudeAvailable();
  res.json({
    ok: true,
    canRun,
    ...(canRun ? { model: config.ANTHROPIC_MODEL, effortDefault: config.ANTHROPIC_EFFORT } : {}),
  });
}
