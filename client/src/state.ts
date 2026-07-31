import type { Effort, Provenance, RunTargets, ScoredState, SseEvent } from "@sb/shared";

export type { ScoredState };

export type RunStatus = "idle" | "running" | "done" | "error";

/** A book as the UI tracks it during verify: starts "pending", then enriched by verification. */
export interface BookView {
  id: string;
  title: string;
  author: string;
  provenance: Provenance;
  nominatedBy: string | null;
  verify: "pending" | "verified" | "unverified" | "dropped";
  year: number | null;
  pageCount: number | null;
  coverUrl: string | null;
  reason?: string;
}

export interface VerifyCounts {
  resolved: number;
  total: number;
  kept: number;
  dropped: number;
}

export interface RunState {
  status: RunStatus;
  runId: string | null;
  members: { name: string }[];
  targets: RunTargets | null;
  effort: Effort | null;
  soloMode: boolean;
  books: BookView[];
  verify: VerifyCounts | null;
  scored: ScoredState | null;
  kept: number | null;
  durationMs: number | null;
  error: string | null;
  warnings: string[];
}

export const initialRunState: RunState = {
  status: "idle",
  runId: null,
  members: [],
  targets: null,
  effort: null,
  soloMode: false,
  books: [],
  verify: null,
  scored: null,
  kept: null,
  durationMs: null,
  error: null,
  warnings: [],
};

export type RunAction =
  | { type: "start" }
  | { type: "sse"; event: SseEvent }
  | { type: "stream_error"; message: string }
  | { type: "load"; members: { name: string }[]; scored: ScoredState }
  | { type: "reset" };

export function runReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case "start":
      return { ...initialRunState, status: "running" };
    case "reset":
      return initialRunState;
    case "stream_error":
      return { ...state, status: "error", error: action.message };
    case "sse":
      return applyEvent(state, action.event);
    case "load":
      return {
        ...initialRunState,
        status: "done",
        members: action.members,
        scored: action.scored,
        kept: action.scored.books.length,
        soloMode: action.members.length <= 1,
      };
    default:
      return state;
  }
}

function applyEvent(state: RunState, event: SseEvent): RunState {
  switch (event.type) {
    case "run_started":
      return {
        ...state,
        status: "running",
        runId: event.runId,
        members: event.members,
        targets: event.targets,
        effort: event.effort,
        soloMode: event.soloMode,
      };
    case "candidates":
      return {
        ...state,
        books: event.candidates.map((c) => ({
          ...c,
          verify: "pending" as const,
          year: null,
          pageCount: null,
          coverUrl: null,
        })),
      };
    case "verify_progress":
      return {
        ...state,
        verify: event.progress,
        books: state.books.map((b) => (b.id === event.id ? mergeVerify(b, event) : b)),
      };
    case "scored":
      return {
        ...state,
        scored: {
          books: event.books,
          clusters: event.clusters,
          coverage: event.coverage,
          selection: event.selection,
        },
      };
    case "warning":
      return { ...state, warnings: [...state.warnings, event.message] };
    case "error":
      return { ...state, status: "error", error: event.message };
    case "done":
      return { ...state, status: "done", kept: event.kept, durationMs: event.durationMs };
    default:
      return state;
  }
}

function mergeVerify(book: BookView, event: Extract<SseEvent, { type: "verify_progress" }>): BookView {
  if (event.status === "dropped") {
    return { ...book, verify: "dropped", reason: event.reason };
  }
  const enriched = event.book;
  return {
    ...book,
    verify: event.status,
    reason: event.reason,
    ...(enriched
      ? { author: enriched.author, year: enriched.year, pageCount: enriched.pageCount, coverUrl: enriched.coverUrl }
      : {}),
  };
}
