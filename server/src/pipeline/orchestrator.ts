import type { Effort, Member, Pace, PastRead, SseEvent, VerifiedBook } from "@sb/shared";
import { ClaudeError } from "../claude/client";
import { embed, embeddingsEnabled } from "../embeddings/client";
import { shortId } from "../util/ids";
import { buildExclusionSet, isExcluded } from "./candidates";
import { nameClusters } from "./clusterNames";
import { filterByConstraints } from "./filterPass";
import { bookPositions, clusterBooks, clusterCentroids } from "./project";
import { generateCandidates } from "./stage1";
import { dedupeByWork, verifyAll } from "./stage2";
import { generateScores } from "./stage3";
import type { SelectionResult } from "./selection";

export interface ResolvedRun {
  members: Member[];
  constraints?: string;
  pace: Pace;
  effort: Effort;
  /** Model override from the UI's quality preset; undefined → the configured default. */
  model?: string;
  soloMode: boolean;
  history?: PastRead[];
}

/**
 * The run pipeline. M3: Stage 1 (candidates) → Stage 2 (verify against Open Library, stream
 * per-book progress) → done. Stage 3 (score) is added in M4.
 */
export async function runPipeline(
  run: ResolvedRun,
  send: (event: SseEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const runId = shortId("run");
  const started = Date.now();

  send({
    type: "run_started",
    runId,
    members: run.members.map((m) => ({ name: m.name })),
    targets: { floor: 15, target: 20, ceiling: 25 },
    effort: run.effort,
    soloMode: run.soloMode,
  });

  let candidates;
  try {
    candidates = await generateCandidates(run, signal, (p) => send({ type: "lens_progress", ...p }));
  } catch (err) {
    if (signal.aborted) return;
    emitError(send, 1, err);
    return;
  }
  send({ type: "candidates", count: candidates.length, candidates });

  let verified: VerifiedBook[];
  let apiErrors = 0;
  try {
    verified = await verifyAll(
      candidates,
      (p) => {
        if (p.reason === "books_api_error") apiErrors++;
        send({ type: "verify_progress", ...p });
      },
      signal,
    );
  } catch (err) {
    if (signal.aborted) return;
    emitError(send, 2, err);
    return;
  }
  if (signal.aborted) return;
  if (apiErrors > 0 && apiErrors >= Math.ceil(candidates.length / 2)) {
    send({
      type: "warning",
      stage: 2,
      code: "books_api_degraded",
      message: "Open Library was unreachable for many books — some couldn't be verified.",
    });
  }

  // Post-verify exclusion sweep: Stage 2 rewrites titles to the catalog's canonical form, so a
  // variant that slipped past the candidate-time check ("Scout Mindset") resurfaces under the
  // exact excluded title — re-check the canonical titles before scoring.
  const excludedSet = buildExclusionSet(run.members, run.history);
  const deduped = dedupeByWork(verified).filter((b) => {
    const out = isExcluded(b.title, excludedSet);
    if (out) console.log(`[exclusions] dropped post-verify: ${b.title}`);
    return !out;
  })
    // Liked books are taste ECHOES, not asks: one we can't verify (usually a hedge-mangled
    // string like "off top of my head probably Sapiens") is noise — drop it. Member
    // SUGGESTIONS stay even unverified (explicit asks earn the verify badge instead).
    .filter((b) => {
      const drop = b.provenance === "member_loved" && b.status === "unverified";
      if (drop) console.log(`[seeds] dropped unverified liked-book: ${b.title}`);
      return !drop;
    });

  // Rule filter: a separate cheap pass AFTER verification (metadata known), never in Stage 1.
  const { kept, removed } = await filterByConstraints(deduped, run.constraints, run.effort, signal);
  if (signal.aborted) return;
  if (removed.length > 0) {
    send({
      type: "warning",
      stage: 2,
      code: "rule_filter",
      message: `Group rules removed ${removed.length}: ${removed.map((r) => `${r.title} (${r.reason})`).join("; ")}`,
    });
  }

  let result: SelectionResult;
  try {
    result = await generateScores(run, kept, signal, (scored, total) => send({ type: "score_progress", scored, total }));
  } catch (err) {
    if (signal.aborted) return;
    emitError(send, 3, err);
    return;
  }
  if (signal.aborted) return;

  await attachSemantics(result, signal, run.model);
  if (signal.aborted) return;

  send({
    type: "scored",
    books: result.books,
    clusters: result.clusters,
    coverage: result.coverage,
    selection: result.selection,
    solo: run.soloMode,
  });
  send({ type: "done", runId, durationMs: Date.now() - started, kept: result.books.length });
}

/**
 * Attach the map's semantics: embed the selected books (locally), cluster them DIRECTLY on the
 * embeddings (geometry from meaning — Stage-3 labels only NAME each cluster by majority vote),
 * and compute 2D centroids for blob placement. Best-effort: any failure keeps Stage-3's label
 * clusters and the deterministic layout — embeddings never fail a run.
 */
async function attachSemantics(result: SelectionResult, signal: AbortSignal, model?: string): Promise<void> {
  if (!embeddingsEnabled() || result.books.length === 0) return;
  try {
    // Embed text = title + what-it's-about + subject tags. Deliberately EXCLUDES author (clusters
    // by author, not topic), rationale/discussability (member-facing, blurs topic geometry), and
    // the cluster label (circular). Only the summary's FIRST paragraph (what it argues) — the
    // reader-reception paragraph reads alike across books and would blur the topic geometry.
    const texts = result.books.map((b) =>
      `${b.title}. ${b.summary.split(/\n{2,}/)[0] ?? ""} ${(b.subjects ?? []).join(", ")}`.replace(/\s+/g, " ").trim(),
    );
    const vecs = await embed(texts, signal);
    if (signal.aborted || vecs.length !== result.books.length) return;
    const embById = new Map(result.books.map((b, i) => [b.id, vecs[i]!]));
    const bookById = new Map(result.books.map((b) => [b.id, b]));

    const groups = clusterBooks(result.books.map((b) => b.id), embById);
    if (groups.length === 0) return;

    // One tiny Claude call names the groups (distinct, subject-based); majority-vote fallback.
    const labels = await nameClusters(groups.map((ids) => ids.map((id) => bookById.get(id)!)), signal, model);
    result.clusters = groups.map((ids, i) => {
      const label = labels[i]!;
      for (const id of ids) bookById.get(id)!.clusterLabel = label;
      return { label, bookIds: ids };
    });
    console.log(`[embeddings] clusters: ${result.clusters.map((c) => `${c.label}(${c.bookIds.length})`).join(", ")}`);

    const centroids = clusterCentroids(result.clusters, embById);
    for (const cl of result.clusters) {
      const c = centroids.get(cl.label);
      if (c) cl.centroid = c;
    }

    // Per-book 2D positions → the map renders one continuous plane; the cluster centroids stay
    // as the fallback blob layout for runs/saves without them.
    const positions = bookPositions(result.books.map((b) => b.id), embById);
    for (const b of result.books) {
      const p = positions.get(b.id);
      if (p) b.pos = p;
    }
  } catch (err) {
    console.warn("[embeddings] positioning skipped:", err instanceof Error ? err.message : err);
  }
}

function emitError(send: (event: SseEvent) => void, stage: 1 | 2 | 3, err: unknown): void {
  if (err instanceof ClaudeError) {
    send({ type: "error", stage, code: err.code, message: err.message, retryable: err.retryable });
    return;
  }
  send({
    type: "error",
    stage,
    code: "internal_error",
    message: err instanceof Error ? err.message : "Unknown error",
    retryable: false,
  });
}
