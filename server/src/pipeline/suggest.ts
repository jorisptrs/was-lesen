import {
  type Candidate,
  type Cluster,
  type Member,
  type PastRead,
  type PendingBook,
  type ScoredCard,
  type SuggestEvent,
  type VerifiedBook,
  scoredMemberNames,
} from "@sb/shared";
import { structuredCall } from "../claude/client";
import { STAGE3_LINE_JSON_SCHEMA, Stage3LineSchema } from "../claude/schemas";
import { titleKey } from "../domain/bookref";
import { embed, embeddingsEnabled } from "../embeddings/client";
import { STAGE3_SYSTEM, assembleStage3User } from "../prompts/assemble";
import { shortId } from "../util/ids";
import { buildExclusionSet, isExcluded } from "./candidates";
import { nameClusters } from "./clusterNames";
import {
  alignPositions,
  carryLabels,
  isPlaceholderLabel,
  previousCentroids,
  previousPositions,
  singleCluster,
} from "./incremental";
import { bookPositions, clusterBooks, clusterCentroids } from "./project";
import { type ScoredInput, type SelectionResult, selectBooks } from "./selection";
import { verifyCandidate } from "./stage2";

/**
 * The member names the EXISTING cards were scored against — read off the cards themselves, not
 * off the request's roster.
 *
 * This is load-bearing. `finalize` rebuilds every book's `perMember` from the names it is given
 * and fills anyone missing with NEUTRAL_FIT, so a roster that has drifted since the run (a
 * renamed card, a member skipped afterwards, a re-imported CSV) silently rewrites the avgFit of
 * every book on the map: ranks reshuffle, and a member whose name no longer matches shows up at
 * fit 5 everywhere — never ≥ SERVE_FIT_MIN — i.e. "unservable" for reasons that have nothing to
 * do with the books. The cards are the map's own contract; the roster only supplies tastes.
 */
export function cardMemberNames(books: ScoredCard[], fallback: Member[]): string[] {
  const names = scoredMemberNames(books);
  return names.length > 0 ? names : fallback.map((m) => m.name);
}

/** A refusal the organizer should read as a sentence, not a stack trace. */
export class SuggestRefused extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "SuggestRefused";
  }
}

export interface CheckInput {
  title: string;
  author: string;
  nominatedBy: string | null;
  members: Member[];
  history?: PastRead[];
  books: ScoredCard[];
  pendingTitles: string[];
}

/**
 * Step one: turn a typed title into a real, verified book — or refuse with a sentence. No
 * Claude, so a name called out in the room costs about a second and the obvious mistakes
 * (already on the map, already read, misspelt) are caught immediately.
 */
export async function checkCandidate(input: CheckInput, signal: AbortSignal): Promise<PendingBook> {
  const key = titleKey({ title: input.title });
  const onMap = input.books.find((b) => titleKey({ title: b.title }) === key);
  if (onMap) throw new SuggestRefused("already_on_map", `"${onMap.title}" is already on the map.`);
  if (input.pendingTitles.some((t) => titleKey({ title: t }) === key)) {
    throw new SuggestRefused("already_pending", `"${input.title}" is already waiting to be scored.`);
  }

  const excluded = buildExclusionSet(input.members, input.history);
  if (isExcluded(input.title, excluded)) {
    throw new SuggestRefused(
      "excluded",
      `"${input.title}" is on the already-read list (a member's, or the group's past reads) — remove it there first if you want it back in play.`,
    );
  }

  const candidate: Candidate = {
    id: shortId("c"),
    title: input.title,
    author: input.author,
    provenance: "organizer_add",
    nominatedBy: input.nominatedBy,
  };
  const verified = await verifyCandidate(candidate, signal);
  // A manual add must be CONFIRMED, which is stricter than the intake path (there a human's
  // unfindable book is kept with a verify badge). The difference is reversibility: an intake
  // typo is fixed in a card and re-run, but there is no way to take a book back OFF a finished
  // map, so a typo would stick. Refusing is the retryable outcome, and the message says how.
  if (verified.status !== "verified" || !verified.book) {
    throw new SuggestRefused(
      "not_found",
      input.author
        ? `No catalog match for "${input.title}" by ${input.author} — check the author's spelling, or leave the author blank.`
        : `No catalog match for "${input.title}" — check the spelling, or add the author.`,
    );
  }

  // Stage 2 rewrites the title to the catalog's canonical form, so re-run the cheap checks
  // against THAT: "scout mindset" resolves to "The Scout Mindset".
  const book = verified.book;
  const canonical = titleKey({ title: book.title });
  const dupe = input.books.find((b) => titleKey({ title: b.title }) === canonical);
  if (dupe) throw new SuggestRefused("already_on_map", `That resolves to "${dupe.title}", which is already on the map.`);
  if (canonical !== key && input.pendingTitles.some((t) => titleKey({ title: t }) === canonical)) {
    throw new SuggestRefused("already_pending", `That resolves to "${book.title}", which is already waiting.`);
  }
  if (isExcluded(book.title, excluded)) {
    throw new SuggestRefused("excluded", `That resolves to "${book.title}", which the group has already read.`);
  }
  return { ...book, nominatedBy: input.nominatedBy };
}

export interface RescoreRun {
  members: Member[];
  constraints?: string;
  history?: PastRead[];
  effort: Parameters<typeof structuredCall>[0]["effort"];
  model?: string;
  books: ScoredCard[];
  clusters: Cluster[];
  pending: PendingBook[];
}

export interface RescoreOutcome {
  result: SelectionResult;
  addedIds: string[];
  message: string;
}

/**
 * Step two: score the WHOLE pool — everything on the map plus everything pending — in one
 * Stage-3 call, then re-select and re-place.
 *
 * Scoring everything together is the point, not an implementation detail. A fit is a judgement
 * relative to the other books in the call; a book scored alone against a few quoted anchors is
 * guessing at a scale it cannot see, which is exactly how manual adds used to land at #1. This
 * is the same call the run makes, so the new books face the same competition the old ones did —
 * and the old ones get re-judged in their company, which is the honest consequence.
 */
export async function rescoreWithPending(
  run: RescoreRun,
  send: (e: SuggestEvent) => void,
  signal: AbortSignal,
): Promise<RescoreOutcome> {
  const memberNames = cardMemberNames(run.books, run.members);
  // Score against exactly the map's member set, in its order. A member the roster no longer
  // carries still gets a fit (every other book has one for them); they just arrive without
  // taste detail rather than dragging the whole map's arithmetic with them.
  const scoringMembers: Member[] = memberNames.map(
    (name) =>
      run.members.find((m) => m.name === name) ?? { name, paragraph: "", suggestions: [], alreadyRead: [], loved: [] },
  );

  // A ScoredCard is a structural superset of a VerifiedBook, so the map's own books go back in
  // as scoring inputs unchanged.
  const pool: VerifiedBook[] = [...run.books, ...run.pending];
  const newIds = new Set(run.pending.map((b) => b.id));

  send({
    type: "suggest_progress",
    phase: "scoring",
    message: `scoring ${pool.length} books (${run.pending.length} new)…`,
  });

  const lines = await structuredCall({
    system: STAGE3_SYSTEM,
    user: assembleStage3User(scoringMembers, run.constraints, pool, run.history),
    effort: run.effort,
    model: run.model,
    lineSchema: STAGE3_LINE_JSON_SCHEMA,
    parseLine: (raw) => Stage3LineSchema.parse(raw),
    keyOf: (l) => l.id,
    expectedKeys: pool.map((b) => b.id),
    followUpUser: (missing) => {
      const byMissing = new Set(missing);
      return (
        `${assembleStage3User(scoringMembers, run.constraints, pool.filter((b) => byMissing.has(b.id)), run.history)}\n\n` +
        `(These books were missing from your previous output — score ONLY these.)`
      );
    },
    expectedLines: pool.length,
    onLines: (n) =>
      send({ type: "suggest_score_progress", scored: Math.min(n, pool.length), total: pool.length }),
    signal,
  });

  const byId = new Map(lines.map((l) => [l.id, l]));
  const inputs: ScoredInput[] = pool.map((b) => {
    const s = byId.get(b.id);
    const previous = run.books.find((p) => p.id === b.id);
    if (s) {
      return {
        ...b,
        complexity: s.complexity,
        mode: s.mode,
        // A summary describes the BOOK, not this scoring pass, so an existing one is kept.
        // That is not just thrift: the summary's first paragraph feeds the embedding, so
        // rewriting it moves a book on the map for reasons that have nothing to do with the
        // books being added. Keeping it is what lets the re-placement stay recognizable.
        summary: previous?.summary?.trim() ? previous.summary : s.summary,
        discussability: s.discussability,
        rationale: s.rationale,
        expedition: s.expedition,
        perMember: s.perMember,
      };
    }
    // Unscored after the recovery call. An existing card keeps what it already had rather than
    // being downgraded to neutral defaults by a gap that has nothing to do with it.
    if (previous) return previous;
    return {
      ...b,
      complexity: "moderate",
      mode: "comfort",
      summary: "",
      discussability: 5,
      rationale: "",
      expedition: false,
      perMember: [],
    };
  });

  send({ type: "suggest_progress", phase: "placing", message: "recomputing the map…" });

  // EVERYTHING is force-included: the books already on the map, plus the new ones. Adding books
  // must not remove others — the pool here is the map itself, not the run's full scored set, so
  // re-running the threshold/floor logic over it was never a fair rerun. The map only grows.
  const forced = new Set(pool.map((b) => b.id));
  const result = selectBooks(inputs, memberNames, memberNames.length <= 1, forced);

  await attachSemanticsIncremental(result, run.clusters, run.books, signal, run.model);

  const added = result.books
    .map((b, i) => ({ b, rank: i + 1 }))
    .filter(({ b }) => newIds.has(b.id))
    .sort((a, z) => a.rank - z.rank);

  return {
    result,
    addedIds: added.map(({ b }) => b.id),
    message: buildMessage(added, result.books.length),
  };
}

function buildMessage(added: { b: ScoredCard; rank: number }[], total: number): string {
  if (added.length === 0) return `Rescored ${total} books.`;
  // Say where they landed, not just that they landed — the organizer is about to show this to
  // the room, and "#18 of 18" is a different answer from "#3".
  const where = added.map(({ b, rank }) => `"${b.title}" #${rank}`).join(", ");
  const weak = added.filter(({ b }) => b.belowThreshold).length;
  const tail =
    weak === added.length && weak > 0
      ? ` ${weak === 1 ? "It scores" : "They score"} below the group's bar — the "why" says what the group would make of ${weak === 1 ? "it" : "them"}.`
      : "";
  return `Rescored all ${total}. Added ${where}.${tail}`;
}

/**
 * Re-place the map: re-embed, re-cluster, carry the existing labels, and re-orient the
 * projection against the previous positions. Deliberately does NOT call `nameClusters` —
 * renaming clusters the group is reading off a projector is a worse outcome than a slightly
 * stale name. Best-effort, like the run's own semantics pass.
 */
async function attachSemanticsIncremental(
  result: SelectionResult,
  prevClusters: Cluster[],
  prevBooks: ScoredCard[],
  signal: AbortSignal,
  model?: string,
): Promise<void> {
  if (result.books.length === 0) return;
  if (!embeddingsEnabled()) {
    result.clusters = singleCluster(result.books);
    return;
  }
  try {
    // Same embed text as the run: title + what-it-argues + subject tags (never author, never
    // the member-facing prose). Everything needed rides on the persisted cards.
    const texts = result.books.map((b) =>
      `${b.title}. ${b.summary.split(/\n{2,}/)[0] ?? ""} ${(b.subjects ?? []).join(", ")}`.replace(/\s+/g, " ").trim(),
    );
    const vecs = await embed(texts, signal);
    if (signal.aborted || vecs.length !== result.books.length) return;
    const embById = new Map(result.books.map((b, i) => [b.id, vecs[i]!]));
    const bookById = new Map(result.books.map((b) => [b.id, b]));

    const groups = clusterBooks(result.books.map((b) => b.id), embById);
    if (groups.length === 0) return;
    result.clusters = carryLabels(groups, prevClusters);
    // Carrying keeps the names (and therefore the colours) of groups that clearly descend from
    // the old map; a rescore can also create a group that descends from nothing, and that one
    // arrives as a "Group 7" placeholder. Name just those — a real topic beside carried topics,
    // instead of renaming the whole map the group is reading off a projector.
    const fresh = result.clusters.filter((c) => isPlaceholderLabel(c.label));
    if (fresh.length > 0) {
      const named = await nameClusters(fresh.map((c) => c.bookIds.map((id) => bookById.get(id)!)), signal, model);
      const used = new Set(result.clusters.map((c) => c.label));
      fresh.forEach((cluster, i) => {
        const proposed = named[i]?.trim();
        if (!proposed || used.has(proposed)) return; // keep the placeholder over a collision
        used.delete(cluster.label);
        used.add(proposed);
        cluster.label = proposed;
      });
    }
    for (const cl of result.clusters) {
      for (const id of cl.bookIds) bookById.get(id)!.clusterLabel = cl.label;
    }

    const centroids = alignPositions(clusterCentroids(result.clusters, embById), previousCentroids(prevClusters));
    for (const cl of result.clusters) {
      const c = centroids.get(cl.label);
      if (c) cl.centroid = c;
    }

    const positions = alignPositions(
      bookPositions(result.books.map((b) => b.id), embById),
      previousPositions(prevBooks),
    );
    for (const b of result.books) {
      const p = positions.get(b.id);
      if (p) b.pos = p;
    }
  } catch (err) {
    console.warn("[suggest] re-placement skipped:", err instanceof Error ? err.message : err);
  }
}
