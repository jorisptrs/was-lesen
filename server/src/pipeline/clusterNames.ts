import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScoredCard } from "@sb/shared";
import { structuredCall } from "../claude/client";
import { CLUSTER_NAME_LINE_JSON_SCHEMA, ClusterNameLineSchema } from "../claude/schemas";
import { config } from "../config";
import { UNGROUPED_LABEL } from "./selection";

const here = dirname(fileURLToPath(import.meta.url));
const SYSTEM = readFileSync(resolve(here, "../prompts/clusterNames.system.md"), "utf8").trim();

/**
 * The degraded story when naming fails. Stage 3 no longer proposes per-book topics (M36), so
 * there is nothing to take a majority of — and that is the point: the old fallback read worst
 * exactly when Stage 3 had over-used one label, and it dressed up a guess as a topic. Generic
 * numbering is honestly uninformative: the groups on the map are still real (the geometry comes
 * from embeddings, not from names), they just went unnamed. A lone group says so in words rather
 * than calling itself "Group 1".
 */
export function fallbackLabels(count: number): string[] {
  if (count <= 1) return count === 1 ? [UNGROUPED_LABEL] : [];
  return Array.from({ length: count }, (_, i) => `Group ${i + 1}`);
}

/**
 * Name the embedding-derived book groups with one tiny Claude call (~$0.001 on Haiku) — the
 * groups see each other, so labels come back distinct and subject-based (the reference's
 * approach). Any failure falls back to `fallbackLabels`; naming never fails a run.
 *
 * A SINGLE group is named for real too (it used to short-circuit to "All books"): the caller may
 * be naming just the one group a rescore newly created, and "All books" would be a lie next to
 * the carried labels around it.
 */
export async function nameClusters(groups: ScoredCard[][], signal?: AbortSignal, model?: string): Promise<string[]> {
  if (groups.length === 0) return [];
  try {
    const section = (books: ScoredCard[], i: number) =>
      `Group ${i + 1}:\n${books.map((b) => `- ${b.title} — ${b.summary.split(/\n{2,}/)[0] ?? ""}`).join("\n")}`;
    const out = await structuredCall({
      system: SYSTEM,
      user: groups.map(section).join("\n\n"),
      effort: config.ANTHROPIC_EFFORT,
      // Ride the run's quality preset: label phrasing is projector-facing, and the call is
      // tiny (~$0.01 even on Opus). Haiku labels drift toward flat subject names.
      model,
      lineSchema: CLUSTER_NAME_LINE_JSON_SCHEMA,
      parseLine: (raw) => ClusterNameLineSchema.parse(raw),
      keyOf: (l) => String(l.group),
      expectedKeys: groups.map((_, i) => String(i + 1)),
      followUpUser: (missing) =>
        `${missing.map((g) => section(groups[Number(g) - 1]!, Number(g) - 1)).join("\n\n")}\n\nLabel ONLY these groups.`,
      expectedLines: groups.length,
      signal,
    });
    const byGroup = new Map(out.map((l) => [l.group, l.label.trim()]));
    const labels = groups.map((_, i) => byGroup.get(i + 1) ?? "").filter(Boolean);
    if (labels.length !== groups.length) return fallbackLabels(groups.length);
    // De-collide defensively (the prompt asks for distinct labels; don't trust it).
    const used = new Set<string>();
    return labels.map((label) => {
      let l = label;
      for (let n = 2; used.has(l); n++) l = `${label} ${n}`;
      used.add(l);
      return l;
    });
  } catch (err) {
    console.warn("[clusterNames] naming failed, groups left unnamed:", err instanceof Error ? err.message : err);
    return fallbackLabels(groups.length);
  }
}
