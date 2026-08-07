import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Effort, VerifiedBook } from "@sb/shared";
import { structuredCall } from "../claude/client";
import { FILTER_LINE_JSON_SCHEMA, FilterLineSchema } from "../claude/schemas";
import { config } from "../config";
import { assembleFilterUser } from "../prompts/assemble";

const here = dirname(fileURLToPath(import.meta.url));
const FILTER_SYSTEM = readFileSync(resolve(here, "../prompts/filter.system.md"), "utf8").trim();

export interface FilterResult {
  kept: VerifiedBook[];
  removed: { id: string; title: string; rule: string; reason: string }[];
}

/**
 * Constraint filter — a separate cheap Claude pass AFTER verification, so Stage 1 generates
 * uncluttered and rules are enforced when the books (and their metadata) are actually known.
 * Conservative by prompt: only clear violations are removed. Best-effort: any failure keeps
 * every book (a missed rule is recoverable in the UI; a failed run is not).
 */
export async function filterByConstraints(
  books: VerifiedBook[],
  constraints: string | undefined,
  effort: Effort,
  signal: AbortSignal,
): Promise<FilterResult> {
  if (!constraints?.trim() || books.length === 0) return { kept: books, removed: [] };
  try {
    const violations = await structuredCall({
      system: FILTER_SYSTEM,
      user: assembleFilterUser(constraints, books),
      model: config.FILTER_MODEL, // Sonnet by default — see config.ts for why
      effort,
      lineSchema: FILTER_LINE_JSON_SCHEMA,
      parseLine: (raw) => FilterLineSchema.parse(raw),
      keyOf: (v) => v.id,
      // No expected keys: violations are a SUBSET, so a clean run that writes nothing is the
      // normal "no book breaks a rule" answer, not a failure to fill in.
      zeroLinesOk: true,
      signal,
    });
    const byId = new Map(books.map((b) => [b.id, b]));
    // Guard against self-contradicting or hedged verdicts (observed: a book listed as a
    // violation whose own reason concluded "no violation") — a removal must be definite.
    const hedged = /no violation|not a violation|which \w+ accepts|acceptable|borderline|\bmay\b|\bmight\b|possibly/i;
    const removed = violations
      .filter((v) => byId.has(v.id))
      .filter((v) => {
        if (hedged.test(v.reason)) {
          console.warn(`[filter] ignoring hedged verdict for ${byId.get(v.id)!.title}: ${v.reason}`);
          return false;
        }
        return true;
      })
      .map((v) => ({ id: v.id, title: byId.get(v.id)!.title, rule: v.rule, reason: v.reason }));
    // Misfire guard: a legitimate rule removes a handful of books; a third of the pool means the
    // model invented a rule (observed: "Kindle" preference → fictitious length limit). Keep all.
    if (removed.length > Math.max(3, Math.ceil(books.length / 3))) {
      console.warn(`[filter] implausible removal count (${removed.length}/${books.length}) — skipping the filter`);
      return { kept: books, removed: [] };
    }
    const removedIds = new Set(removed.map((r) => r.id));
    return { kept: books.filter((b) => !removedIds.has(b.id)), removed };
  } catch (err) {
    if (signal.aborted) throw err;
    console.warn("[filter] rule filter skipped:", err instanceof Error ? err.message : err);
    return { kept: books, removed: [] };
  }
}
