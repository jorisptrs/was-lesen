import type { NormalizeResult } from "@sb/shared";
import type { NormalizeLine } from "../claude/schemas";

// Stage-0 request shaping and reconciliation — pure, so the route is only transport.

export type NormalizeKind = "entry" | "paragraph" | "rule";

export interface NormalizeInput {
  entries: string[];
  paragraphs: string[];
  rules: string[];
}

const MAX_ENTRIES = 200; // ~10-person group × up to ~15 books each, comfortably in one call
const MAX_TEXTS = 24;

const cleanStrings = (v: unknown, cap: number, maxLen: number): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, maxLen)).slice(0, cap)
    : [];

/** Sanitize + cap the three request lists. Empty everywhere = nothing to do (the route 400s). */
export function resolveNormalizeInput(body: unknown): NormalizeInput {
  const b = (body ?? {}) as { entries?: unknown; paragraphs?: unknown; rules?: unknown };
  return {
    entries: Array.isArray(b.entries)
      ? b.entries.filter((e): e is string => typeof e === "string" && e.trim().length > 0).slice(0, MAX_ENTRIES)
      : [],
    paragraphs: cleanStrings(b.paragraphs, MAX_TEXTS, 2000),
    rules: cleanStrings(b.rules, MAX_TEXTS, 500),
  };
}

export const normalizeTotal = (input: NormalizeInput): number =>
  input.entries.length + input.paragraphs.length + input.rules.length;

export const normalizeKeys = (input: NormalizeInput): string[] => [
  ...input.entries.map((_, i) => `entry:${i + 1}`),
  ...input.paragraphs.map((_, i) => `paragraph:${i + 1}`),
  ...input.rules.map((_, i) => `rule:${i + 1}`),
];

/**
 * Render the numbered user prompt. The three lists are independent and lines arrive across
 * turns, so `index` — not position in the output — is what aligns them. `only` keeps the
 * ORIGINAL numbers, so a follow-up call merges into the same index space.
 */
export function renderNormalizeUser(input: NormalizeInput, only?: Set<string>): string {
  const section = (label: string, xs: string[], kind: NormalizeKind): string => {
    const picked = xs.map((text, i) => ({ text, n: i + 1 })).filter(({ n }) => !only || only.has(`${kind}:${n}`));
    return picked.length ? `${label}:\n${picked.map(({ text, n }) => `${n}. ${text}`).join("\n")}` : "";
  };
  return [
    section("Entries", input.entries, "entry"),
    section("Paragraphs", input.paragraphs, "paragraph"),
    section("Rules", input.rules, "rule"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Fold the returned lines back onto the request, by index. Tolerant everywhere: an item with no
 * line stays exactly as the member typed it (Stage 0 is a nice-to-have, never a gate), and a
 * cleanup that returns an empty paragraph for a substantial original is treated as a miss.
 */
export function reconcileNormalize(
  input: NormalizeInput,
  lines: NormalizeLine[],
): { result: NormalizeResult; missed: number } {
  const byKey = new Map(lines.map((l) => [`${l.type}:${l.index}`, l]));
  let missed = 0;

  const entries = input.entries.map((original, i) => {
    const line = byKey.get(`entry:${i + 1}`);
    if (line?.type === "entry") {
      return {
        original,
        kind: line.kind,
        title: line.title,
        author: line.author,
        authorFromText: line.authorFromText,
      };
    }
    missed++;
    return { original, kind: "book" as const, title: original, author: "", authorFromText: false };
  });

  const textAt = (kind: "paragraph" | "rule", i: number, fallback: string): string => {
    const line = byKey.get(`${kind}:${i + 1}`);
    return line?.type === kind ? line.text : fallback;
  };

  return {
    result: {
      entries,
      paragraphs: input.paragraphs.map((p, i) => textAt("paragraph", i, p)),
      rules: input.rules.map((r, i) => textAt("rule", i, r)),
    },
    missed,
  };
}
