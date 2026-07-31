import type { Request, Response } from "express";
import { config } from "../config";

export function handleHealth(_req: Request, res: Response): void {
  res.json({ ok: true, model: config.ANTHROPIC_MODEL, effortDefault: config.ANTHROPIC_EFFORT });
}
