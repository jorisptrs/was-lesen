import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BookRef, Member, PastRead, VerifiedBook } from "@sb/shared";

// Frozen system prompts, loaded once at boot. Changed only via git commit (no in-app editing).
const here = dirname(fileURLToPath(import.meta.url));
const load = (f: string): string => readFileSync(resolve(here, f), "utf8").trim();

/** Stage 1 runs as three parallel lens passes over the same user prompt (see pipeline/stage1). */
export const STAGE1_SYSTEMS = {
  champions: load("stage1.champions.system.md"),
  bridges: load("stage1.bridges.system.md"),
  wildcards: load("stage1.wildcards.system.md"),
} as const;
export type Stage1Lens = keyof typeof STAGE1_SYSTEMS;

export const STAGE3_SYSTEM = load("stage3.system.md");

const fmtBook = (b: BookRef): string => (b.author ? `${b.title} — ${b.author}` : b.title);

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

/** Past group reads as prompt lines — the shared read/exclude/calibrate block. */
function historyLines(history: PastRead[] | undefined): string[] {
  if (!history?.length) return [];
  const lines = ["Past group reads (already read TOGETHER — never propose these again):"];
  for (const h of history) {
    const facts = [
      h.avgRating != null ? `avg ${h.avgRating}/5` : null,
      h.finished ?? null,
    ].filter(Boolean).join("; ");
    lines.push(`- ${h.title}${h.author ? ` — ${h.author}` : ""}${facts ? ` (${facts})` : ""}`);
    for (const n of h.notes ?? []) {
      lines.push(`    ${n.member}${n.rating != null ? ` (${n.rating}/5)` : ""}: "${n.note}"`);
    }
  }
  lines.push("");
  return lines;
}

/**
 * The Stage-1 user prompt: the group's tastes, exclusions, past reads, seeded suggestions, and
 * the lens-specific ask. Deliberately NO constraints — a post-verification filter pass enforces
 * group rules, so generation stays uncluttered.
 */
export function assembleStage1User(
  members: Member[],
  seeded: BookRef[],
  history: PastRead[] | undefined,
  ask: string,
): string {
  const lines: string[] = [];
  lines.push(`This reading group has ${members.length} member${members.length === 1 ? "" : "s"}.`, "");

  lines.push("Members and their tastes:");
  for (const m of members) {
    lines.push(`- ${m.name}: ${m.paragraph || "(no description given)"}`);
    if (m.loved.length) lines.push(`    loves: ${m.loved.map(fmtBook).join("; ")}`);
  }
  lines.push("");

  const excluded = dedupe(members.flatMap((m) => m.alreadyRead.map(fmtBook)));
  if (excluded.length) {
    lines.push("Already read — do NOT propose these:", ...excluded.map((x) => `- ${x}`), "");
  }

  lines.push(...historyLines(history));

  if (seeded.length) {
    lines.push(
      "Already in the pool (member suggestions) — do NOT repeat these; complement them:",
      ...seeded.map((b) => `- ${fmtBook(b)}`),
      "",
    );
  }

  lines.push(ask);
  return lines.join("\n");
}

/** The Stage-3 user prompt: the group's tastes, past-read feedback, plus the verified books. */
export function assembleStage3User(
  members: Member[],
  constraints: string | undefined,
  books: VerifiedBook[],
  history?: PastRead[],
): string {
  const names = members.map((m) => m.name);
  const lines: string[] = [];
  lines.push(`Reading group members: ${names.join(", ")}.`, "");

  if (constraints?.trim()) lines.push("Group constraints:", constraints.trim(), "");

  lines.push("Members and their tastes:");
  for (const m of members) {
    lines.push(`- ${m.name}: ${m.paragraph || "(no description given)"}`);
    if (m.loved.length) lines.push(`    loves: ${m.loved.map(fmtBook).join("; ")}`);
  }
  lines.push("");

  lines.push(...historyLines(history));

  lines.push("Books to score (use the exact id):");
  for (const b of books) {
    const facts = [b.year ? String(b.year) : null, b.pageCount ? `${b.pageCount}p` : null].filter(Boolean).join(", ");
    lines.push(`- [${b.id}] ${b.title}${b.author ? ` — ${b.author}` : ""}${facts ? ` (${facts})` : ""}`);
  }
  lines.push("");

  lines.push(
    `For EACH book rate fit 1–10 for EVERY member (${names.join(", ")}), plus discussability, a ` +
      `reused cluster label, complexity, comfort/stretch, the two-paragraph summary, a ` +
      `rationale, and expedition. Return JSON keyed by id, matching the schema.`,
  );
  return lines.join("\n");
}

/** The constraint-filter user prompt: the rules plus the verified books to judge. */
export function assembleFilterUser(constraints: string, books: VerifiedBook[]): string {
  const lines: string[] = ["Group rules:", constraints.trim(), "", "Books (use the exact id):"];
  for (const b of books) {
    const facts = [b.year ? String(b.year) : null, b.pageCount ? `${b.pageCount}p` : null].filter(Boolean).join(", ");
    lines.push(`- [${b.id}] ${b.title}${b.author ? ` — ${b.author}` : ""}${facts ? ` (${facts})` : ""}`);
  }
  lines.push("", "List the books that CLEARLY violate a rule. Return JSON matching the schema.");
  return lines.join("\n");
}
