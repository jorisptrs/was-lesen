import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, Response } from "express";
import { ClaudeError, structuredCall } from "../claude/client";
import { NORMALIZE_JSON_SCHEMA, NormalizeSchema } from "../claude/schemas";
import { config } from "../config";
import { checkRateLimit } from "../ratelimit/rateLimiter";

const here = dirname(fileURLToPath(import.meta.url));
const NORMALIZE_SYSTEM = readFileSync(resolve(here, "../prompts/normalize.system.md"), "utf8").trim();

const MAX_ENTRIES = 200; // ~10-person group × up to ~15 books each, comfortably in one call
const MAX_TEXTS = 24;

const cleanStrings = (v: unknown, cap: number, maxLen: number): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, maxLen)).slice(0, cap)
    : [];

/**
 * POST /api/normalize — Stage 0: clean up raw human-typed intake text via one cheap Claude call.
 * Body `{entries: string[], paragraphs?: string[], rules?: string[]}`:
 *  - `entries` (book-list strings) → `{original, kind, title, author, authorFromText}` each;
 *  - `paragraphs` / `rules` → the same texts with pleasantries/meta removed, in order.
 * Used at CSV import so corrections land in the editable cards BEFORE a run. Failures are the
 * client's cue to proceed with the raw strings — this endpoint is a nice-to-have, never a gate.
 */
export async function handleNormalize(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as { entries?: unknown; paragraphs?: unknown; rules?: unknown };
  const entries = Array.isArray(body.entries)
    ? body.entries.filter((e): e is string => typeof e === "string" && e.trim().length > 0).slice(0, MAX_ENTRIES)
    : [];
  const paragraphs = cleanStrings(body.paragraphs, MAX_TEXTS, 2000);
  const rules = cleanStrings(body.rules, MAX_TEXTS, 500);
  if (entries.length === 0 && paragraphs.length === 0 && rules.length === 0) {
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

  const section = (label: string, xs: string[]): string =>
    xs.length ? `${label}:\n${xs.map((e, i) => `${i + 1}. ${e}`).join("\n")}` : "";
  const user = [section("Entries", entries), section("Paragraphs", paragraphs), section("Rules", rules)]
    .filter(Boolean)
    .join("\n\n");

  try {
    const out = await structuredCall({
      system: NORMALIZE_SYSTEM,
      user,
      model: config.NORMALIZE_MODEL, // optional stronger model; undefined → ANTHROPIC_MODEL
      maxTokens: 10240, // entries + echoed cleaned paragraphs; streamed, so long is safe
      effort: config.ANTHROPIC_EFFORT,
      jsonSchema: NORMALIZE_JSON_SCHEMA,
      validate: (raw) => NormalizeSchema.parse(raw),
    });
    // Reconcile by the echoed `original` (models occasionally drop an entry mid-list, which
    // would corrupt purely positional alignment): consume matching echoes in order; an input
    // with no echo left degrades to as-typed instead of failing the whole cleanup. Duplicates
    // are handled by queueing per original.
    const queues = new Map<string, (typeof out.entries)[number][]>();
    for (const e of out.entries) {
      const key = e.original.trim();
      const q = queues.get(key) ?? [];
      q.push(e);
      queues.set(key, q);
    }
    let missed = 0;
    const reconciled = entries.map((original) => {
      const e = queues.get(original.trim())?.shift();
      if (e) return { ...e, original };
      missed++;
      return { original, kind: "book" as const, title: original, author: "", authorFromText: false };
    });
    if (missed > 0) console.warn(`[normalize] ${missed} entr(ies) had no echo — left as typed`);
    res.json({
      entries: reconciled,
      // Tolerant on the text arrays: a short return just means those items stay as typed.
      paragraphs: out.paragraphs.slice(0, paragraphs.length),
      rules: out.rules.slice(0, rules.length),
    });
  } catch (err) {
    const message = err instanceof ClaudeError ? err.message : "Normalization failed.";
    res.status(502).json({ error: message });
  }
}
