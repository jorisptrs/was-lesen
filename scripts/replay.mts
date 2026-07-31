// Offline replay harness: re-run the POST-Claude pipeline steps (dedup → embed → cluster →
// name → centroids) over a previously captured run, with ZERO API cost. Lets us iterate on
// clustering/dedup logic against real data without re-running Claude or the books APIs.
//
//   npx tsx scripts/replay.mts <input> [output.json]
//
// <input> = a saved-run JSON (from the app's "Save run") OR a captured SSE log containing
// `event: scored` / `event: run_started` frames. Writes an updated loadable SavedRun (default:
// alongside the input, suffixed `.replayed.json`) and prints the cluster distributions.
import { readFileSync, writeFileSync } from "node:fs";
import type { Cluster, ScoredCard } from "@sb/shared";
import { embed } from "../server/src/embeddings/client.ts";
import { nameClusters } from "../server/src/pipeline/clusterNames.ts";
import { bookPositions, clusterBooks, clusterCentroids } from "../server/src/pipeline/project.ts";
import { dedupeByWork } from "../server/src/pipeline/stage2.ts";

interface ScoredPayload {
  books: ScoredCard[];
  clusters: Cluster[];
  coverage: { member: string; served: number; bookIds: string[] }[];
  selection: Record<string, unknown> & { kept: number };
}

function loadInput(path: string): { scored: ScoredPayload; saved: Record<string, unknown> | null } {
  const raw = readFileSync(path, "utf8");
  if (raw.trimStart().startsWith("{")) {
    const json = JSON.parse(raw);
    if (json.app === "satisfying-books") return { scored: json.scored, saved: json };
    if (json.books && json.clusters) return { scored: json, saved: null };
    throw new Error("Unrecognized JSON input.");
  }
  // SSE log: pull the scored + run_started data frames.
  const frame = (type: string) => {
    const m = raw.match(new RegExp(`event: ${type}\\n\\[[ 0-9]+s\\] data: (.*)`));
    if (!m) throw new Error(`no ${type} event in the log`);
    return JSON.parse(m[1]!);
  };
  const scored = frame("scored");
  const started = frame("run_started");
  return {
    scored,
    saved: {
      app: "satisfying-books",
      version: 1,
      savedAt: new Date().toISOString(),
      input: { membersText: "(replayed from a captured run)", constraints: "", pace: { pages: 75, weeks: 2 }, effort: "low" },
      members: started.members,
      scored,
    },
  };
}

const [inputPath, outPathArg] = process.argv.slice(2);
if (!inputPath) {
  console.error("usage: npx tsx scripts/replay.mts <saved-run.json | sse.log> [out.json]");
  process.exit(1);
}
const { scored, saved } = loadInput(inputPath);

const fmt = (clusters: { label: string; bookIds: string[] }[]) =>
  clusters.map((c) => `${c.label}(${c.bookIds.length})`).join(", ");
console.log("before :", scored.books.length, "books ·", fmt(scored.clusters));

// 1. Dedup (work key + canonical-title fallback).
const books = dedupeByWork(scored.books);
const ids = new Set(books.map((b) => b.id));

// 2. Embed (local, $0) + cluster on the embeddings + name by majority Stage-3 label.
const texts = books.map((b) => {
  // Tolerate pre-summary saves (oneLineSummary) so old captures stay replayable.
  const summary = b.summary ?? (b as ScoredCard & { oneLineSummary?: string }).oneLineSummary ?? "";
  return `${b.title}. ${summary.split(/\n{2,}/)[0] ?? ""} ${(b.subjects ?? []).join(", ")}`.replace(/\s+/g, " ").trim();
});
const vecs = await embed(texts);
const embById = new Map(books.map((b, i) => [b.id, vecs[i]!]));
const bookById = new Map(books.map((b) => [b.id, b]));

const groups = clusterBooks(books.map((b) => b.id), embById);
// Naming makes one tiny Haiku call (~$0.001); on failure it falls back to majority labels.
const labels = await nameClusters(groups.map((ids) => ids.map((id) => bookById.get(id)!)));
const clusters: Cluster[] = groups.map((groupIds, i) => {
  const label = labels[i]!;
  for (const id of groupIds) bookById.get(id)!.clusterLabel = label;
  return { label, bookIds: groupIds };
});

// 3. Centroids (blob fallback) + per-book positions (the filled-plane map).
const centroids = clusterCentroids(clusters, embById);
for (const cl of clusters) {
  const c = centroids.get(cl.label);
  if (c) cl.centroid = c;
}
const positions = bookPositions(books.map((b) => b.id), embById);
for (const b of books) {
  const p = positions.get(b.id);
  if (p) b.pos = p;
}
console.log("after  :", books.length, "books ·", fmt(clusters));

// 4. Write a loadable SavedRun.
const coverage = scored.coverage.map((c) => {
  const kept = c.bookIds.filter((id) => ids.has(id));
  return { ...c, bookIds: kept, served: kept.length };
});
const out = {
  ...(saved ?? {}),
  savedAt: new Date().toISOString(),
  scored: { books, clusters, coverage, selection: { ...scored.selection, kept: books.length } },
};
const outPath = outPathArg ?? inputPath.replace(/(\.[a-z]+)?$/, ".replayed.json");
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log("wrote  :", outPath);
