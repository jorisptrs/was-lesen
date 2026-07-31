import type { Request, Response } from "express";
import { googleBooksEnabled } from "../books/googleBooks";
import { config } from "../config";
import { checkRateLimit } from "../ratelimit/rateLimiter";
import { resolveGbMatch, resolveMatch } from "../pipeline/stage2";

const MAX_ENTRIES = 100;

interface ResolveEntry {
  title: string;
  author: string;
}

/**
 * POST /api/resolve — canonicalize book refs against the books APIs (cache-first, $0 Claude).
 * Body `{entries: {title, author}[]}` → per entry `{matched, title, author}` with the catalog's
 * casing/title and a filled-in author when the member typed none. Used at CSV import so the
 * member cards show the same book the map will. Best-effort: a miss echoes the input unmatched.
 */
export async function handleResolve(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as { entries?: unknown };
  const entries: ResolveEntry[] = Array.isArray(body.entries)
    ? body.entries
        .filter((e): e is { title: string; author?: unknown } => !!e && typeof (e as { title?: unknown }).title === "string")
        .map((e) => ({ title: e.title.trim(), author: typeof e.author === "string" ? e.author.trim() : "" }))
        .filter((e) => e.title.length > 0)
        .slice(0, MAX_ENTRIES)
    : [];
  if (entries.length === 0) {
    res.status(400).json({ error: "Provide a non-empty `entries: {title, author?}[]`." });
    return;
  }

  // One batched call per CSV import — a modest own bucket keeps a public URL from hammering
  // the books APIs through us without touching the run budget.
  const rl = checkRateLimit(`resolve:${req.ip ?? "unknown"}`, 60);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retryAfter));
    res.status(429).json({ error: `Rate limit reached. Try again in ${rl.retryAfter}s.` });
    return;
  }

  const controller = new AbortController();
  // Abort on CLIENT disconnect. res "close" (not req "close": for a buffered POST body,
  // req "close" fires as soon as the body is read, which would abort our own lookups).
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  // Small worker pool — same books-API politeness as Stage 2.
  const out: { matched: boolean; title: string; author: string }[] = new Array(entries.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < entries.length; i = next++) {
      const e = entries[i]!;
      try {
        const match =
          (await resolveMatch(e, controller.signal)) ??
          (googleBooksEnabled() ? await resolveGbMatch(e, controller.signal) : null);
        out[i] = match
          ? {
              matched: true,
              // Keep OUR cleaned title — catalog titles are often noisier (sentence case,
              // dropped articles: "Thinking in systems", "Fall of Roe"). The catalog's value
              // here is confirming the match and filling a missing author.
              title: e.title,
              author: e.author || (match.doc.author_name?.[0] ?? ""),
            }
          : { matched: false, title: e.title, author: e.author };
      } catch {
        out[i] = { matched: false, title: e.title, author: e.author }; // best-effort, never fail the batch
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(config.BOOKS_CONCURRENCY, entries.length) }, worker));

  if (controller.signal.aborted) return;
  res.json({ entries: out });
}
