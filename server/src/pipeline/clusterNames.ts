import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScoredCard } from "@sb/shared";
import { structuredCall } from "../claude/client";
import { CLUSTER_NAMES_JSON_SCHEMA, ClusterNamesSchema } from "../claude/schemas";
import { config } from "../config";

const here = dirname(fileURLToPath(import.meta.url));
const SYSTEM = readFileSync(resolve(here, "../prompts/clusterNames.system.md"), "utf8").trim();

/**
 * Fallback naming: each group's most frequent Stage-3 label (ties → the highest-avgFit book's
 * label), de-collided with a numeric suffix. Used when the naming call fails — and it reads
 * poorly exactly when Stage-3 over-used one label, which is why the Claude namer is primary.
 */
export function majorityLabels(groups: ScoredCard[][]): string[] {
  const used = new Set<string>();
  return groups.map((books) => {
    const counts = new Map<string, number>();
    for (const b of books) counts.set(b.clusterLabel, (counts.get(b.clusterLabel) ?? 0) + 1);
    const top = Math.max(...counts.values());
    const contenders = new Set([...counts.entries()].filter(([, c]) => c === top).map(([l]) => l));
    const best = [...books].sort((a, z) => z.avgFit - a.avgFit).find((b) => contenders.has(b.clusterLabel))!;
    let label = best.clusterLabel;
    for (let n = 2; used.has(label); n++) label = `${best.clusterLabel} ${n}`;
    used.add(label);
    return label;
  });
}

/**
 * Name the embedding-derived book groups with one tiny Claude call (~$0.001 on Haiku) — the
 * groups see each other, so labels come back distinct and subject-based (the reference's
 * approach). Any failure falls back to `majorityLabels`; naming never fails a run.
 */
export async function nameClusters(groups: ScoredCard[][], signal?: AbortSignal, model?: string): Promise<string[]> {
  if (groups.length < 2) return majorityLabels(groups);
  try {
    const user = groups
      .map((books, i) => `Group ${i + 1}:\n${books.map((b) => `- ${b.title} — ${b.summary.split(/\n{2,}/)[0] ?? ""}`).join("\n")}`)
      .join("\n\n");
    const out = await structuredCall({
      system: SYSTEM,
      user,
      maxTokens: 512,
      effort: config.ANTHROPIC_EFFORT,
      // Ride the run's quality preset: label phrasing is projector-facing, and the call is
      // tiny (~$0.01 even on Opus). Haiku labels drift toward flat subject names.
      model,
      jsonSchema: CLUSTER_NAMES_JSON_SCHEMA,
      validate: (raw) => ClusterNamesSchema.parse(raw),
      signal,
    });
    const labels = out.labels.map((l) => l.trim()).filter(Boolean);
    if (labels.length !== groups.length) return majorityLabels(groups);
    // De-collide defensively (the prompt asks for distinct labels; don't trust it).
    const used = new Set<string>();
    return labels.map((label) => {
      let l = label;
      for (let n = 2; used.has(l); n++) l = `${label} ${n}`;
      used.add(l);
      return l;
    });
  } catch (err) {
    console.warn("[clusterNames] naming failed, using majority labels:", err instanceof Error ? err.message : err);
    return majorityLabels(groups);
  }
}
