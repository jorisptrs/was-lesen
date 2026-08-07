// Convert a Tally CSV export into the tool's `Name: paragraph` block format (which the server
// parser already understands). Columns are matched by HEADER NAME, so a trimmed export with
// only the relevant fields still works. The output goes into the members textarea — transparent
// and editable, reusing the whole existing pipeline.

import { type PastRead, parseCsv } from "@sb/shared";

export { parseCsv };

export interface TallyMember {
  name: string;
  paragraph: string;
  loved: string[];
  read: string[];
  suggest: string[];
  /** Sitting the next book out — excluded (with their prefs/constraints) from the run. */
  skip?: boolean;
}

/** Drop constraint lines belonging to skipped members ("Sasha: no Russian classics" goes when
 * Sasha sits this one out); lines without a name prefix are group-wide and always stay. */
export function stripSkippedConstraints(constraints: string, skippedNames: string[]): string {
  if (skippedNames.length === 0) return constraints;
  const skipped = new Set(skippedNames.map((n) => n.trim().toLowerCase()));
  return constraints
    .split("\n")
    .filter((line) => {
      const m = line.match(/^\s*([^:]{1,40}):/);
      return !(m && skipped.has(m[1]!.trim().toLowerCase()));
    })
    .join("\n");
}

export interface PaceStats {
  perMember: { name: string; low: number; high: number }[];
  min: number; // slowest reader's lower bound
  median: number; // median of each member's range-midpoint — the planning default
  max: number; // fastest reader's upper bound
  slowest: string; // name of the member with the lowest lower bound
}

export interface TallyImport {
  /** Structured per-member records — mutate the lists (e.g. AI normalization), then serialize. */
  members: TallyMember[];
  text: string;
  count: number;
  /** Suggested group planning pace (pages / 2 weeks): the median of members' midpoints. */
  paceHint: number | null;
  /** The spread of members' reported paces, so the group can see it without adopting the slowest. */
  paceStats: PaceStats | null;
  /** Group-level notes from "Anything else?" (language, format, diversity asks) as `Name: text` lines. */
  constraints: string;
}

/** Parse a "#pages per 2 weeks" answer into a low/high range: "50-100"→{50,100}, "100"→{100,100},
 * free text with no number → null. */
export function parsePaceRange(s: string): { low: number; high: number } | null {
  const nums = (s.match(/\d+/g) ?? []).map(Number).filter((n) => n > 0);
  if (nums.length === 0) return null;
  return { low: Math.min(...nums), high: Math.max(...nums) };
}

const LIST_KEY: Record<string, keyof Pick<TallyMember, "loved" | "read" | "suggest">> = {
  loved: "loved", love: "loved", loves: "loved", favorite: "loved", favorites: "loved", favourites: "loved",
  read: "read", alreadyread: "read", haveread: "read", dontredo: "read", excluded: "read", exclude: "read",
  suggest: "suggest", suggestion: "suggest", suggestions: "suggest", nominate: "suggest", nomination: "suggest",
};
const classifyKey = (raw: string) => LIST_KEY[raw.trim().toLowerCase().replace(/[\s_-]+/g, "")] ?? null;

/** Parse the `Name: paragraph` block format (mirrors the server's parseMembers) into records the
 * card deck edits; the inverse of `buildMembersText`. Lists split on ";" (how buildMembersText joins). */
export function parseMembersText(text: string): TallyMember[] {
  const blocks = text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  return blocks.map((block, idx) => {
    const lines = block
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const m: TallyMember = { name: `Member ${idx + 1}`, paragraph: "", loved: [], read: [], suggest: [] };
    const para: string[] = [];
    let start = 0;
    const nameMatch = lines[0]?.match(/^([^:]{1,40}):\s*(.*)$/);
    if (nameMatch && !classifyKey(nameMatch[1]!)) {
      m.name = nameMatch[1]!.trim();
      if (nameMatch[2]!.trim()) para.push(nameMatch[2]!.trim());
      start = 1;
    }
    for (let i = start; i < lines.length; i++) {
      const sub = lines[i]!.match(/^([A-Za-z][\w '-]{0,20}):\s*(.*)$/);
      const field = sub ? classifyKey(sub[1]!) : null;
      if (sub && field) m[field].push(...sub[2]!.split(";").map((s) => s.trim()).filter(Boolean));
      else para.push(lines[i]!);
    }
    m.paragraph = para.join(" ").replace(/\s+/g, " ").trim();
    return m;
  });
}

const findCol = (header: string[], test: (h: string) => boolean): number =>
  header.findIndex((h) => test(h.toLowerCase().trim()));

/** A filled-in optional field that still says nothing ("none", "not really", "n/a", "-", …). */
const isNoAnswer = (s: string): boolean =>
  !s || /^(none( yet)?|no|n\/a|na|nah|not really|nothing( much)?|nope|-)[.!]?$/i.test(s.trim());

// Split a free-text book list, stripping the bullet ("- ", "• ") and numbering ("1. ", "2) ")
// prefixes people naturally type in Tally's long-answer fields. If the field contains newlines
// the person listed one book per line — split on lines/semicolons only, so commas INSIDE a title
// ("Superintelligence: Paths, Dangers, Strategies") survive; otherwise commas separate books.
// NOTE: hedging prose ("off the top of my head probably Sapiens") is deliberately NOT stripped
// here — real titles begin with hedge-like words ("Maybe You Should Talk to Someone", "I Think
// You'll Find It's a Bit More Complicated Than That"), so only the Stage-0 LLM can separate
// meta-language from title words. See prompts/normalize.system.md.
const splitList = (s: string): string[] =>
  s
    .split(s.includes("\n") ? /[;\n]/ : /[,;\n]/)
    // Strip leading bullet/numbering FIRST, so a numbered "3. Decoded: The Science…" isn't mistaken
    // for an "Author: Title" boundary by the multi-book split below.
    .map((x) => x.trim().replace(/^(?:[-–—•*]|\d+[.)])\s+/, ""))
    // Split "Author: Title. Author: Title." runs (people separate them with ". " between
    // "Name: …" entries) — only at a period that precedes a fresh "Capitalized name:" prefix.
    .flatMap((p) => p.split(/\.\s+(?=[A-Z][^:.]{1,40}:\s)/))
    .map((x) => x.trim().replace(/(?<!\.)\.$/, "").trim()) // drop a single trailing period
    .filter(Boolean);

/** Serialize structured members back into the `Name: paragraph` block format. Empty list entries
 * (a transient artifact of live line-by-line editing) are filtered out of the output. */
export function buildMembersText(members: TallyMember[]): string {
  const join = (a: string[]) =>
    a
      .map((s) => s.trim())
      .filter(Boolean)
      .join("; ");
  return members
    .map((m) => {
      const lines = [`${m.name.trim() || "Member"}: ${m.paragraph.trim() || "(no description given)"}`];
      if (join(m.loved)) lines.push(`  loved: ${join(m.loved)}`);
      if (join(m.read)) lines.push(`  read: ${join(m.read)}`);
      if (join(m.suggest)) lines.push(`  suggest: ${join(m.suggest)}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

/**
 * Is this the post-read FEEDBACK export rather than the intake one?
 *
 * The feedback form is no longer imported — past reads are typed into the Past reads panel, which
 * is the same information without a second Tally form, a second parser, and a per-member shape
 * that had to be collapsed to a group note anyway. This check survives only to recognise the old
 * file and say so, instead of parsing it as an intake and inventing members out of feedback rows.
 */
export function isFeedbackCsv(csvText: string): boolean {
  const header = (parseCsv(csvText)[0] ?? []).map((h) => h.toLowerCase());
  const has = (t: string) => header.some((h) => h.includes(t));
  return has("book") && (has("finish") || has("satisf") || has("rating"));
}

/** Aggregate reported reading budgets into display stats — recomputable from any subset,
 * so skipped members' budgets drop out of the suggestion and the graph. */
export function paceStatsFrom(rows: { name: string; low: number; high: number }[]): PaceStats | null {
  if (rows.length === 0) return null;
  // MEDIAN, not mean: one member who reads 600 pages a fortnight would otherwise drag the whole
  // group's planning default up and halve every "N sessions" estimate on the map.
  const midpoints = rows.map((p) => (p.low + p.high) / 2).sort((a, z) => a - z);
  const mid = Math.floor(midpoints.length / 2);
  const median = midpoints.length % 2 === 0 ? (midpoints[mid - 1]! + midpoints[mid]!) / 2 : midpoints[mid]!;
  const slowest = rows.reduce((m, p) => (p.low < m.low ? p : m));
  return {
    perMember: rows,
    min: Math.min(...rows.map((p) => p.low)),
    median: Math.round(median),
    max: Math.max(...rows.map((p) => p.high)),
    slowest: slowest.name,
  };
}

export function tallyCsvToMembersText(csvText: string): TallyImport {
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw new Error("That CSV has no responses.");
  const header = rows[0]!;

  const col = {
    name: findCol(header, (h) => h.includes("name")),
    pages: findCol(header, (h) => h.includes("pages")),
    interested: findCol(header, (h) => h.includes("interested in reading")),
    concretely: findCol(header, (h) => h.includes("concretely")),
    list1: findCol(header, (h) => h.includes("list books") && !h.includes("(2)")),
    list2: findCol(header, (h) => h.includes("list books") && h.includes("(2)")),
    anything: findCol(header, (h) => h.includes("anything")),
    // Optional scout-mindset question — lands in the member's own words so the fit rubric
    // legitimately rewards books that challenge what they asked to have challenged.
    belief: findCol(header, (h) => h.includes("stress-test") || h.includes("belief") || h.includes("wrong")),
  };
  if (col.interested < 0 && col.name < 0) {
    throw new Error("That CSV doesn't look like a Tally export (no name / interest columns).");
  }

  const get = (r: string[], i: number): string => (i >= 0 ? (r[i] ?? "").trim() : "");

  const members: TallyMember[] = [];
  const notes: string[] = [];
  const paceRows: { name: string; low: number; high: number }[] = [];

  rows.slice(1).forEach((r) => {
    const interested = get(r, col.interested);
    // Column mapping (confirmed against the group's Tally form), in form order:
    //   "Concretely"        → 3–5 books you've loved      → loved  (taste signal)
    //   "List books..."     → already read, don't redo    → read   (hard exclusion)
    //   "List books... (2)" → books you'd like to suggest → suggest (candidate seeds)
    const loved = splitList(get(r, col.concretely));
    const read = splitList(get(r, col.list1));
    const suggest = splitList(get(r, col.list2));

    const belief = get(r, col.belief).replace(/\s+/g, " ").trim();
    const beliefLine = isNoAnswer(belief) ? "" : `Belief I'd like stress-tested: ${belief}`;

    if (!interested && !beliefLine && !loved.length && !read.length && !suggest.length) return; // empty response

    const name = get(r, col.name) || `Member ${members.length + 1}`;
    const paragraph = [interested.replace(/\s+/g, " ").trim(), beliefLine].filter(Boolean).join(" ");
    members.push({ name, paragraph, loved, read, suggest });

    // "Anything else?" is a group-level note (language, formats, diversity asks) — surface it in
    // the constraints box where both prompts treat it as a rule, not buried in a paragraph.
    const anything = get(r, col.anything).replace(/\s+/g, " ").trim();
    if (anything) notes.push(`${name}: ${anything}`);

    const range = parsePaceRange(get(r, col.pages));
    if (range) paceRows.push({ name, ...range });
  });

  if (members.length === 0) throw new Error("No usable responses found in that CSV.");

  const paceStats = paceStatsFrom(paceRows);

  return {
    members,
    text: buildMembersText(members),
    count: members.length,
    paceHint: paceStats ? paceStats.median : null,
    paceStats,
    constraints: notes.join("\n"),
  };
}
