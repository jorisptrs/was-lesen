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

/** Reading pace: `pages` read per `weeks`-long period (default 180 / 2). */
export interface Pace {
  pages: number;
  weeks: number;
}

/** A book the group already read together, with how it landed. Sourced from the past-reads
 * store (organizer-maintained) — the per-member feedback-form import was removed once the store
 * made it redundant, so `notes` in practice carries one entry attributed to "the group". */
export interface PastRead {
  title: string;
  author?: string;
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
  /** Past group reads + feedback — excluded from candidates, calibrates Stage-3 fits. */
  history?: PastRead[];
}

/** `organizer_add` = typed into the suggest bar during the session. When it carries a member's
 * name it reads like a nomination; unattributed it stays deliberately neutral ("added in the
 * room"), because inventing an owner for a book is exactly the misattribution the provenance
 * badge exists to prevent. */
export type Provenance = "member_nomination" | "member_loved" | "claude_own_pick" | "organizer_add";

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
  /** One Stage-1 lens pass reporting in. Stage 1 is minutes of silence otherwise: the lenses
   * run in parallel and only the union is announced (`candidates`). */
  | { type: "lens_progress"; lens: string; lines: number; quota: number; state: "running" | "done" | "failed" }
  | { type: "candidates"; count: number; candidates: Candidate[] }
  | {
      type: "verify_progress";
      id: string;
      status: "verified" | "unverified" | "dropped";
      reason?: string;
      book?: VerifiedBook;
      progress: { resolved: number; total: number; kept: number; dropped: number };
    }
  /** Books scored so far. Stage 3 takes minutes on a real pool, so it reports as it goes. */
  | { type: "score_progress"; scored: number; total: number }
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
// Stage 0 — normalize stream (POST /api/normalize → text/event-stream)
// ---------------------------------------------------------------------------------------
//
// Its own event union, deliberately not folded into `SseEvent`: that union is the wire
// contract for a RUN, and one shared union would let a run event type-check inside a
// normalize consumer (and vice versa). The client's SSE reader is generic over the union.

/** One raw intake string after Stage-0 cleanup. `kind: "rule"` = prose that belongs in the
 * constraints box; `not_a_book` = a note to drop. */
export interface NormalizedEntry {
  original: string;
  kind: "book" | "not_a_book" | "rule";
  title: string;
  author: string;
  /** True only if the author literally appeared in the member's text (never inferred). */
  authorFromText: boolean;
}

export interface NormalizeResult {
  entries: NormalizedEntry[];
  /** Cleaned member paragraphs and constraint lines, positionally aligned with the request. */
  paragraphs: string[];
  rules: string[];
}

// ---------------------------------------------------------------------------------------
// Manual suggestion (POST /api/suggest → text/event-stream)
// ---------------------------------------------------------------------------------------

/**
 * Adding books to a finished map is TWO steps, deliberately.
 *
 * `POST /api/suggest/check` verifies one title against the books catalog — fast, free, no
 * Claude — so a name called out in the room becomes a real book (cover, pages, subjects) the
 * moment it's typed. Books pile up unscored.
 *
 * `POST /api/suggest/rescore` then scores the WHOLE pool — everything already on the map plus
 * everything pending — in one Stage-3 call. That is the point: fits are only meaningful
 * relative to the other books in the call, so a book scored alone against a handful of quoted
 * anchors was always a weaker judgement than one scored beside its real competition.
 */
export interface CheckRequest {
  title: string;
  author?: string;
  /** The member to attribute it to, or null/absent for a neutral "added in the room". */
  nominatedBy?: string | null;
  /** The map as it stands, so an already-present book is refused before anything is spent. */
  books: ScoredCard[];
  membersText?: string;
  members?: Member[];
  history?: PastRead[];
  /** Titles already waiting to be scored — refused as duplicates too. */
  pendingTitles?: string[];
}

/** A verified-but-unscored book waiting for the next rescore. */
export interface PendingBook extends VerifiedBook {
  nominatedBy: string | null;
}

export interface RescoreRequest {
  /** The map as it stands: full cards (they carry the positions and labels to align against). */
  books: ScoredCard[];
  clusters: Cluster[];
  /** Verified additions to score alongside them. */
  pending: PendingBook[];
  membersText?: string;
  members?: Member[];
  constraints?: string;
  quality?: RunQuality;
  history?: PastRead[];
}

export type SuggestEvent =
  | { type: "suggest_progress"; phase: "scoring" | "placing"; message: string }
  /** Books scored so far in this rescore, so a multi-minute pass reports like a run does. */
  | { type: "suggest_score_progress"; scored: number; total: number }
  | {
      type: "suggest_result";
      books: ScoredCard[];
      clusters: Cluster[];
      coverage: MemberCoverage[];
      selection: SelectionMeta;
      /** Ids of the newly added books that made the map (all of them — they are force-kept). */
      addedIds: string[];
      /** Human-readable outcome (where they ranked), shown next to the suggest bar. */
      message: string;
    }
  | { type: "suggest_error"; code: string; message: string };

export type NormalizeEvent =
  /** Items whose cleaned line has landed, out of the total asked for. Never decreases. */
  | { type: "normalize_progress"; done: number; total: number }
  | { type: "normalize_result"; result: NormalizeResult }
  | { type: "normalize_error"; message: string };

// ---------------------------------------------------------------------------------------
// Show-Prompt preview (POST /api/run/preview → assembled prompts, no Claude call)
// ---------------------------------------------------------------------------------------

export interface PromptPreview {
  model: string;
  effort: Effort;
  stage1: { system: string; user: string };
  stage3: { system: string; userTemplate: string };
}
