import type { BookRef, Candidate } from "@sb/shared";
import { structuredCall } from "../claude/client";
import { STAGE1_LINE_JSON_SCHEMA, Stage1LineSchema } from "../claude/schemas";
import { STAGE1_SYSTEMS, type Stage1Lens, assembleStage1User } from "../prompts/assemble";
import { buildExclusionSet, filterClaudeCandidates, seedPool } from "./candidates";
import type { ResolvedRun } from "./orchestrator";

/** Books asked of each lens. A solo run has one lens doing all the work, so it asks for more. */
export const GROUP_LENS_QUOTA = 12;
export const SOLO_LENS_QUOTA = 16;

/** Which lenses run for this group. Solo drops bridges — there is nobody to bridge to. */
export function lensesFor(memberCount: number): Stage1Lens[] {
  return memberCount < 2 ? ["wildcards"] : ["bridges", "wildcards"];
}

/** How many books a lens is asked for — drives the ask line, the timeout, and progress totals. */
export function lensQuota(memberCount: number): number {
  return memberCount < 2 ? SOLO_LENS_QUOTA : GROUP_LENS_QUOTA;
}

/** The lens-specific ask lines (counts live here, not in the frozen system prompts). */
export function lensAsk(lens: Stage1Lens, memberCount: number): string {
  const q = lensQuota(memberCount);
  const tail = "Title and author only, no commentary — one output line per book.";
  // Solo: no "two members" framing anywhere — the system prompt's carve-out covers the focus
  // line, and the ask must not reintroduce it.
  if (memberCount < 2) {
    return lens === "bridges"
      ? `Propose ${q} books for this reader. ${tail}`
      : `Propose ${q} wildcard books for this reader. ${tail}`;
  }
  return lens === "bridges"
    ? `Propose ${q} bridge books, each serving at least two different members. ${tail}`
    : `Propose ${q} wildcard books, each serving at least two different members. ${tail}`;
}

/** Progress for one lens pass: `lines` climbs as proposals land in the call's output file. */
export type LensProgress = (p: { lens: Stage1Lens; lines: number; quota: number; state: LensState }) => void;
export type LensState = "running" | "done" | "failed";

/**
 * Stage 1: seed member suggestions + PARALLEL Claude lens passes over the same basis — bridges
 * (the best book two+ members meet in) and wildcards (the same, but one they haven't heard of).
 * The union is deduped and exclusion-filtered server-side. One failed lens degrades the pool, it
 * doesn't fail the run; all of them failing does.
 */
export async function generateCandidates(
  run: ResolvedRun,
  signal: AbortSignal,
  onLens?: LensProgress,
): Promise<Candidate[]> {
  const excluded = buildExclusionSet(run.members, run.history);
  const seeded = seedPool(run.members, run.history);
  const seededRefs: BookRef[] = seeded.map((c) => ({ title: c.title, ...(c.author ? { author: c.author } : {}) }));

  const lenses = lensesFor(run.members.length);
  const quota = lensQuota(run.members.length);
  // Announce each lens before its call so the UI shows the full denominator from the start —
  // otherwise "0/12" would appear only once the first lines land, ~a minute in.
  for (const lens of lenses) onLens?.({ lens, lines: 0, quota, state: "running" });
  const results = await Promise.allSettled(
    lenses.map((lens) =>
      structuredCall({
        system: STAGE1_SYSTEMS[lens],
        user: assembleStage1User(run.members, seededRefs, run.history, lensAsk(lens, run.members.length)),
        effort: run.effort,
        model: run.model,
        lineSchema: STAGE1_LINE_JSON_SCHEMA,
        parseLine: (raw) => Stage1LineSchema.parse(raw),
        // No keys to reconcile: a lens proposes a free list, and the union is deduped and
        // exclusion-filtered downstream, so a short lens is a smaller pool rather than a gap.
        expectedLines: quota,
        onLines: onLens ? (lines) => onLens({ lens, lines: Math.min(lines, quota), quota, state: "running" }) : undefined,
        signal,
      }),
    ),
  );

  const raw: { title: string; author: string }[] = [];
  const errors: unknown[] = [];
  results.forEach((r, i) => {
    const lens = lenses[i]!;
    if (r.status === "fulfilled") {
      raw.push(...r.value);
      onLens?.({ lens, lines: Math.min(r.value.length, quota), quota, state: "done" });
      console.log(`[stage1] ${lens}: ${r.value.length} candidates`);
    } else {
      errors.push(r.reason);
      // A failed lens keeps its own denominator so the counter can't imply work still to come.
      onLens?.({ lens, lines: 0, quota: 0, state: "failed" });
      console.warn(`[stage1] ${lens} failed:`, r.reason instanceof Error ? r.reason.message : r.reason);
    }
  });
  if (raw.length === 0 && errors.length > 0) throw errors[0];

  const claudeCandidates = filterClaudeCandidates(raw, seeded, excluded);
  return [...seeded, ...claudeCandidates];
}
