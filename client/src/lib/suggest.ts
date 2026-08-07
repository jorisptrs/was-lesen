import type { CheckRequest, PendingBook, RescoreRequest, ScoredState, SuggestEvent } from "@sb/shared";
import { errorMessage } from "./api";
import { postSseStream } from "./sse";

// Adding books is two steps (see shared/types): a cheap per-title catalog check, then ONE
// scoring pass over the whole pool.

/** Verify one typed title. Throws with the server's sentence on a refusal (already on the map,
 * already read, no catalog match) — those are answers, not failures. */
export async function checkBook(body: CheckRequest): Promise<PendingBook> {
  const res = await fetch("/api/suggest/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  const { book } = (await res.json()) as { book: PendingBook };
  return book;
}

export interface RescoreOutcome {
  scored: ScoredState;
  /** Ids of the books just added (they are force-kept, so all of them). */
  addedIds: string[];
  message: string;
}

/**
 * Score the whole pool — map + pending — in one pass. Minutes of work, so it streams: a phase
 * message, then a running k/n as lines land.
 *
 * Deliberately NOT routed through `useRunStream`: its `start` dispatches "start", which wipes
 * the scored state — the map would vanish while the organizer waits.
 */
export async function rescoreBooks(
  body: RescoreRequest,
  onPhase: (message: string) => void,
): Promise<RescoreOutcome> {
  const got: { outcome: RescoreOutcome | null; error: string | null } = { outcome: null, error: null };
  await postSseStream<SuggestEvent>("/api/suggest/rescore", body, (e) => {
    if (e.type === "suggest_progress") onPhase(e.message);
    else if (e.type === "suggest_score_progress") onPhase(`scoring ${e.scored}/${e.total}…`);
    else if (e.type === "suggest_error") got.error = e.message;
    else if (e.type === "suggest_result") {
      got.outcome = {
        scored: { books: e.books, clusters: e.clusters, coverage: e.coverage, selection: e.selection },
        addedIds: e.addedIds,
        message: e.message,
      };
    }
  });
  if (got.error) throw new Error(got.error);
  if (!got.outcome) throw new Error("The rescore stream ended without a result — try again.");
  return got.outcome;
}
