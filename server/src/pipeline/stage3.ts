import type { VerifiedBook } from "@sb/shared";
import { structuredCall } from "../claude/client";
import { STAGE3_JSON_SCHEMA, Stage3Schema } from "../claude/schemas";
import { STAGE3_SYSTEM, assembleStage3User } from "../prompts/assemble";
import type { ResolvedRun } from "./orchestrator";
import type { ScoredInput, SelectionResult } from "./selection";
import { SELECTION, selectBooks } from "./selection";

/** Stage 3: Claude scores each verified book per member; the app reconciles + selects. */
export async function generateScores(
  run: ResolvedRun,
  verified: VerifiedBook[],
  signal: AbortSignal,
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

  const out = await structuredCall({
    system: STAGE3_SYSTEM,
    user: assembleStage3User(run.members, run.constraints, verified, run.history),
    // ~45 books × (two-paragraph summary + per-member scores) fits well under Haiku's 64K cap;
    // streamed, so a long generation is safe.
    maxTokens: 48000,
    effort: run.effort,
    model: run.model,
    jsonSchema: STAGE3_JSON_SCHEMA,
    validate: (raw) => Stage3Schema.parse(raw),
    signal,
  });

  const byId = new Map(out.books.map((b) => [b.id, b]));
  const inputs: ScoredInput[] = verified.map((v) => {
    const s = byId.get(v.id);
    if (s) {
      return {
        ...v,
        clusterLabel: s.clusterLabel.trim() || "Other",
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
      clusterLabel: "Other",
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
