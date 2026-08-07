import type { VerifiedBook } from "@sb/shared";
import { structuredCall } from "../claude/client";
import { STAGE3_LINE_JSON_SCHEMA, Stage3LineSchema } from "../claude/schemas";
import { STAGE3_SYSTEM, assembleStage3User } from "../prompts/assemble";
import type { ResolvedRun } from "./orchestrator";
import type { ScoredInput, SelectionResult } from "./selection";
import { SELECTION, selectBooks } from "./selection";

/** Stage 3: Claude scores each verified book per member; the app reconciles + selects. */
export async function generateScores(
  run: ResolvedRun,
  verified: VerifiedBook[],
  signal: AbortSignal,
  onProgress?: (scored: number, total: number) => void,
): Promise<SelectionResult> {
  const memberNames = run.members.map((m) => m.name);
  if (verified.length === 0) {
    return {
      books: [],
      clusters: [],
      coverage: memberNames.map((member) => ({ member, served: 0, bookIds: [] })),
      selection: {
        threshold: SELECTION.QUALITY_MIN,
        target: SELECTION.TARGET,
        floor: SELECTION.FLOOR,
        ceiling: SELECTION.CEILING,
        kept: 0,
        quietMemberPulls: [],
        unservableMembers: [],
      },
    };
  }

  // The whole pool goes in one call on purpose: cross-book calibration is what the rubric asks
  // for, and it only works if the model sees every book at once. That used to collide with the
  // CLI's per-response token cap; the file protocol lifts it by spending turns instead.
  const scored = await structuredCall({
    system: STAGE3_SYSTEM,
    user: assembleStage3User(run.members, run.constraints, verified, run.history),
    effort: run.effort,
    model: run.model,
    lineSchema: STAGE3_LINE_JSON_SCHEMA,
    parseLine: (raw) => Stage3LineSchema.parse(raw),
    keyOf: (b) => b.id,
    expectedKeys: verified.map((v) => v.id),
    // Re-send the members, constraints and history alongside the missing books: a bare list of
    // ids would be scored without the tastes the fits are supposed to be anchored in.
    followUpUser: (missing) => {
      const byMissing = new Set(missing);
      return (
        `${assembleStage3User(run.members, run.constraints, verified.filter((v) => byMissing.has(v.id)), run.history)}\n\n` +
        `(These books were missing from your previous output — score ONLY these.)`
      );
    },
    expectedLines: verified.length,
    onLines: (n) => onProgress?.(Math.min(n, verified.length), verified.length),
    signal,
  });

  const byId = new Map(scored.map((b) => [b.id, b]));
  const inputs: ScoredInput[] = verified.map((v) => {
    const s = byId.get(v.id);
    if (s) {
      return {
        ...v,
        complexity: s.complexity,
        mode: s.mode,
        summary: s.summary,
        discussability: s.discussability,
        rationale: s.rationale,
        expedition: s.expedition,
        perMember: s.perMember,
      };
    }
    // Claude omitted this book → neutral defaults (stays in the pool, ranks low).
    return {
      ...v,
      complexity: "moderate",
      mode: "comfort",
      summary: "",
      discussability: 5,
      rationale: "",
      expedition: false,
      perMember: [],
    };
  });

  return selectBooks(inputs, memberNames, run.soloMode);
}
