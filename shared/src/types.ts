// Types shared between client and server. The SSE event union is the wire contract for a
// run; the domain types (Member, Candidate, …) are the pipeline's data model.
//
// Shapes for later stages (VerifiedBook, ScoredCard) are provisional and will be refined as
// Stages 2–3 land (M3/M4). Kept here now so the client can be typed end-to-end.

// ---------------------------------------------------------------------------------------
// Core domain
// ---------------------------------------------------------------------------------------

export interface BookRef {
  title: string;
  author?: string;
}

/** One reading-group member's intake (from the Tally form, or the interim manual input). */
export interface Member {
  name: string;
  paragraph: string;
  /** Books this member would like the group to read → seed the candidate pool. */
  suggestions: BookRef[];
  /** Books this member has read and doesn't want to redo → hard exclusion. */
  alreadyRead: BookRef[];
  /** 3–5 books this member loves → taste signal (not shown on the map, not excluded). */
  loved: BookRef[];
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** UI-selectable run quality: a named preset the SERVER maps to model + effort. The client
 * never sends raw model strings — a public URL must not request arbitrary expensive models. */
export type RunQuality = "test" | "standard" | "best";

/** Reading pace: `pages` read per `weeks`-long period (default 160 / 2). */
export interface Pace {
  pages: number;
  weeks: number;
}

/** A book the group already read together, with post-read feedback (from the feedback form). */
export interface PastRead {
  title: string;
  author?: string;
  /** e.g. "5/8 finished". */
  finished?: string;
  /** Mean satisfaction 1–5, or null if nobody rated. */
  avgRating?: number | null;
  notes?: { member: string; rating: number | null; note: string }[];
}

export interface RunRequest {
  /** Canonical structured input (e.g. from a Tally import). */
  members?: Member[];
  /** Interim manual input: `Name: paragraph` blocks the server parses into `members`. */
  membersText?: string;
  constraints?: string;
  pace?: Pace;
  soloMode?: boolean;
  /** Preferred: a named preset (test/standard/best). Overrides `effort` when present. */
  quality?: RunQuality;
  /** Legacy raw effort (still honored when no `quality` is sent). */
  effort?: Effort;
  maxEffortPassphrase?: string;
  /** Past group reads + feedback — excluded from candidates, calibrates Stage-3 fits. */
  history?: PastRead[];
}

export type Provenance = "member_nomination" | "member_loved" | "claude_own_pick";

/** A proposed book after Stage 1 (before verification). */
export interface Candidate {
  id: string;
  title: string;
  author: string;
  provenance: Provenance;
  /** The member who suggested (`member_nomination`) or liked (`member_loved`) it. */
  nominatedBy: string | null;
}

// ---------------------------------------------------------------------------------------
// Stage 2 — verified/enriched (provisional; refined at M3)
// ---------------------------------------------------------------------------------------

export type VerifyStatus = "verified" | "unverified";
export type PageCountSource = "openlibrary_median" | "openlibrary_single" | "googlebooks" | "unknown";

export interface VerifiedBook extends Candidate {
  status: VerifyStatus;
  year: number | null;
  pageCount: number | null;
  pageCountSource: PageCountSource;
  coverUrl: string | null;
  olWorkKey: string | null;
  matchConfidence: number;
  /** A few subject/category tags from the books API — topical signal for map clustering. */
  subjects?: string[];
}

// ---------------------------------------------------------------------------------------
// Stage 3 — scored card (provisional; refined at M4)
// ---------------------------------------------------------------------------------------

export type Complexity = "light" | "moderate" | "demanding";
export type ReadingMode = "comfort" | "stretch";

export interface MemberFit {
  member: string;
  fit: number;
}

export interface ScoredCard extends VerifiedBook {
  clusterLabel: string;
  /** Normalized 2D embedding position (0..1) — drives the filled-plane map. Absent → blob layout. */
  pos?: { x: number; y: number };
  complexity: Complexity;
  mode: ReadingMode;
  /** Two short paragraphs (blank-line separated): what the book argues; how readers receive it. */
  summary: string;
  discussability: number;
  rationale: string;
  expedition: boolean;
  perMember: MemberFit[];
  /** Server-computed. */
  avgFit: number;
  servesMost: string[];
  belowThreshold: boolean;
  pulledInFor: string | null;
}

export interface Cluster {
  label: string;
  bookIds: string[];
  /** Normalized 2D position (0..1) from embeddings, for the semantic map. Absent → deterministic layout. */
  centroid?: { x: number; y: number };
}

export interface MemberCoverage {
  member: string;
  served: number;
  bookIds: string[];
}

export interface SelectionMeta {
  threshold: number;
  target: number;
  floor: number;
  ceiling: number;
  kept: number;
  quietMemberPulls: { member: string; bookId: string }[];
  unservableMembers: string[];
}

export interface RunTargets {
  floor: number;
  target: number;
  ceiling: number;
}

// ---------------------------------------------------------------------------------------
// SSE events (server → client). Discriminated on `type`.
// ---------------------------------------------------------------------------------------

export type SseEvent =
  | {
      type: "run_started";
      runId: string;
      members: { name: string }[];
      targets: RunTargets;
      effort: Effort;
      soloMode: boolean;
    }
  | { type: "candidates"; count: number; candidates: Candidate[] }
  | {
      type: "verify_progress";
      id: string;
      status: "verified" | "unverified" | "dropped";
      reason?: string;
      book?: VerifiedBook;
      progress: { resolved: number; total: number; kept: number; dropped: number };
    }
  | {
      type: "scored";
      books: ScoredCard[];
      clusters: Cluster[];
      coverage: MemberCoverage[];
      selection: SelectionMeta;
      solo: boolean;
    }
  | { type: "warning"; stage: 1 | 2 | 3; code: string; message: string }
  | { type: "error"; stage: 1 | 2 | 3 | null; code: string; message: string; retryable: boolean }
  | { type: "done"; runId: string; durationMs: number; kept: number };

export type SseEventType = SseEvent["type"];

// ---------------------------------------------------------------------------------------
// Show-Prompt preview (POST /api/run/preview → assembled prompts, no Claude call)
// ---------------------------------------------------------------------------------------

export interface PromptPreview {
  model: string;
  effort: Effort;
  stage1: { system: string; user: string };
  stage3: { system: string; userTemplate: string };
}
