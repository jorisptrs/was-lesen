import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BookRef, Member, PastRead, VerifiedBook } from "@sb/shared";

// Frozen system prompts, loaded once at boot. Changed only via git commit (no in-app editing).
const here = dirname(fileURLToPath(import.meta.url));
const load = (f: string): string => readFileSync(resolve(here, f), "utf8").trim();

/**
 * Stage 1 runs as parallel lens passes over the same user prompt (see pipeline/stage1). Both
 * lenses now stand on the same basis — books connecting at least two members' stated interests —
 * and differ only in what they reach for: bridges takes the best such book, wildcards takes the
 * one the group hasn't heard of. The per-member CHAMPIONS lens was removed at M36 (under mean
 * aggregation its books only ever surfaced via the coverage override, which draws from the whole
 * pool anyway; the quota went into these two, and manual suggestion is the human backstop).
 */
export const STAGE1_SYSTEMS = {
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
    const rating = h.avgRating != null ? ` (avg ${h.avgRating}/5)` : "";
    lines.push(`- ${h.title}${h.author ? ` — ${h.author}` : ""}${rating}`);
    for (const n of h.notes ?? []) {
      lines.push(`    ${n.member}${n.rating != null ? ` (${n.rating}/5)` : ""}: "${n.note}"`);
    }
  }
  // Generalization guidance rides WITH the feedback (this block feeds both Stage-1 generation
  // and Stage-3 scoring, so one seam covers proposing AND ranking) — and only when there is
  // actual sentiment to generalize from. Bare titles are exclusions, nothing more.
  if (history.some((h) => h.avgRating != null || h.notes?.length)) {
    lines.push(
      "Treat this feedback as TASTE EVIDENCE, not just a do-not-repeat list. When a low rating " +
        "or a note names what failed — the author, the density, the style, the topic — steer " +
        "clear of close repeats: another book by an author the group panned needs strong " +
        "counter-evidence to propose or score well. When a past read landed, its close " +
        "neighbours are good bets. Draw only the inferences the feedback itself supports.",
    );
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
    `For EACH book rate fit 1–10 for EVERY member (${names.join(", ")}), plus discussability, ` +
      `complexity, comfort/stretch, the two-paragraph summary, a rationale, and expedition — ` +
      `one output line per book, keyed by its exact id.`,
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
  lines.push("", "List the books that CLEARLY violate a rule — one output line per violation.");
  return lines.join("\n");
}
