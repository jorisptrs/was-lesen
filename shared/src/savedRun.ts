import type { Cluster, Effort, MemberCoverage, Pace, PastRead, RunQuality, ScoredCard, SelectionMeta } from "./types";

/** The scored outcome of a run — everything the map renders. */
export interface ScoredState {
  books: ScoredCard[];
  clusters: Cluster[];
  coverage: MemberCoverage[];
  selection: SelectionMeta;
}

/** A downloaded run: everything needed to re-render the map offline, no server/API required. */
export interface SavedRun {
  app: "satisfying-books";
  version: 1;
  savedAt: string;
  model?: string;
  input: {
    membersText: string;
    constraints: string;
    pace: Pace;
    /** Named model/effort preset (newer saves). */
    quality?: RunQuality;
    /** Raw effort (older saves; kept so they still load). */
    effort?: Effort;
    history?: PastRead[];
    /** Names of members sitting the next book out (skips persist across save/load). */
    skipped?: string[];
  };
  members: { name: string }[];
  scored: ScoredState;
}

/**
 * Validate an already-parsed saved run. Shared so the server vets POSTed share payloads with
 * the same rules the client uses for file loads. Throws a human-readable Error on mismatch.
 */
export function validateSavedRun(data: unknown): SavedRun {
  if (!data || typeof data !== "object") throw new Error("Unrecognized file.");
  const d = data as Partial<SavedRun>;
  if (d.app !== "satisfying-books") throw new Error("This isn't a satisfying-books run file.");
  if (d.version !== 1) throw new Error(`Unsupported run version (${String(d.version)}).`);
  if (!d.scored || !Array.isArray(d.scored.books)) throw new Error("Run file is missing its scored books.");
  if (!Array.isArray(d.members)) throw new Error("Run file is missing its members.");
  if (!d.input || typeof d.input !== "object" || !d.input.pace) throw new Error("Run file is missing its input.");
  // Per-book floor: id + title must be strings (the vote tally sorts/keys on them and would
  // 500 later on a malformed POSTed run). Migrate pre-summary saves in the same pass.
  for (const b of d.scored.books as (ScoredCard & { oneLineSummary?: string })[]) {
    if (typeof b.id !== "string" || typeof b.title !== "string") {
      throw new Error("Run file has a malformed book entry.");
    }
    if (typeof b.summary !== "string") b.summary = b.oneLineSummary ?? "";
  }
  return d as SavedRun;
}
