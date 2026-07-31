import type { BookRef, Candidate } from "@sb/shared";
import { structuredCall } from "../claude/client";
import { STAGE1_JSON_SCHEMA, Stage1Schema } from "../claude/schemas";
import { STAGE1_SYSTEMS, type Stage1Lens, assembleStage1User } from "../prompts/assemble";
import { titleKey } from "../domain/bookref";
import { buildExclusionSet, filterClaudeCandidates, isExcluded, seedLoved, seedNominations } from "./candidates";
import type { ResolvedRun } from "./orchestrator";

/** Per-member champions quota: 2 in a real group; more when few members carry the whole pool. */
export function championsQuota(memberCount: number): number {
  return memberCount >= 4 ? 2 : Math.ceil(8 / Math.max(1, memberCount));
}

/** The lens-specific ask lines (counts live here, not in the frozen system prompts). */
export function lensAsk(lens: Stage1Lens, memberCount: number): string {
  if (lens === "champions") {
    const q = championsQuota(memberCount);
    return (
      `For EACH member propose exactly ${q} book${q === 1 ? "" : "s"} chosen for that member alone ` +
      `(${q * memberCount} total). Title and author only, no commentary. Return JSON matching the schema.`
    );
  }
  if (lens === "bridges") {
    return "Propose 8 bridge books, each serving at least two different members. Title and author only, no commentary. Return JSON matching the schema.";
  }
  return "Propose 8 wildcard books. Title and author only, no commentary. Return JSON matching the schema.";
}

/**
 * Stage 1: seed member suggestions + three PARALLEL Claude lens passes — per-member champions
 * (minority tastes get guaranteed slots), bridges (books two+ members meet in), and wildcards
 * (recent / non-mainstream finds). The union is deduped and exclusion-filtered server-side.
 * One failed lens degrades the pool, it doesn't fail the run; all three failing does.
 */
export async function generateCandidates(run: ResolvedRun, signal: AbortSignal): Promise<Candidate[]> {
  const excluded = buildExclusionSet(run.members, run.history);
  // Exclusions beat suggestions: a member re-suggesting a book someone marked don't-redo (or a
  // past group read) must not slip in through the seeded pool — variant-matched, so a subtitled
  // entry can't evade a bare-title exclusion.
  const suggestions = seedNominations(run.members).filter((c) => !isExcluded(c.title, excluded));
  // Liked books seed too ("Liked by X" — quality proven for one member), with suggestions taking
  // precedence on overlap; exclusions and the rule filter apply to them like everything else.
  const suggestionKeys = new Set(suggestions.map((c) => titleKey(c)));
  const loved = seedLoved(run.members).filter((c) => !isExcluded(c.title, excluded) && !suggestionKeys.has(titleKey(c)));
  const seeded = [...suggestions, ...loved];
  const seededRefs: BookRef[] = seeded.map((c) => ({ title: c.title, ...(c.author ? { author: c.author } : {}) }));

  const lenses: Stage1Lens[] = run.members.length < 2 ? ["champions", "wildcards"] : ["champions", "bridges", "wildcards"];
  const results = await Promise.allSettled(
    lenses.map((lens) =>
      structuredCall({
        system: STAGE1_SYSTEMS[lens],
        user: assembleStage1User(run.members, seededRefs, run.history, lensAsk(lens, run.members.length)),
        maxTokens: 2048,
        effort: run.effort,
        model: run.model,
        jsonSchema: STAGE1_JSON_SCHEMA,
        validate: (raw) => Stage1Schema.parse(raw),
        signal,
      }),
    ),
  );

  const raw: { title: string; author: string }[] = [];
  const errors: unknown[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      raw.push(...r.value.candidates);
      console.log(`[stage1] ${lenses[i]}: ${r.value.candidates.length} candidates`);
    } else {
      errors.push(r.reason);
      console.warn(`[stage1] ${lenses[i]} failed:`, r.reason instanceof Error ? r.reason.message : r.reason);
    }
  });
  if (raw.length === 0 && errors.length > 0) throw errors[0];

  const claudeCandidates = filterClaudeCandidates(raw, seeded, excluded);
  return [...seeded, ...claudeCandidates];
}
