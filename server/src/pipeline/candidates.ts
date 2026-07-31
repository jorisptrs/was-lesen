import type { Candidate, Member, PastRead } from "@sb/shared";
import { titleVariants } from "../books/match";
import { titleKey } from "../domain/bookref";
import { shortId } from "../util/ids";

const stripArticle = (v: string): string => v.replace(/^(the|a|an) /, "");

// Pure candidate-pool helpers (no Claude, no config) — unit-tested.

/** Member suggestions → seeded candidates (`member_nomination`), deduped by normalized title. */
export function seedNominations(members: Member[]): Candidate[] {
  return seedList(members, "suggestions", "member_nomination");
}

/** Members' liked books → seeded candidates (`member_loved`) — quality proven for at least one
 * member ("champion picks"). The pipeline gives suggestions precedence and applies exclusions
 * and the rule filter, so a liked-but-banned or liked-but-already-read book never surfaces. */
export function seedLoved(members: Member[]): Candidate[] {
  return seedList(members, "loved", "member_loved");
}

function seedList(
  members: Member[],
  field: "suggestions" | "loved",
  provenance: Candidate["provenance"],
): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const m of members) {
    for (const s of m[field]) {
      const key = titleKey(s);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: shortId("c"),
        title: s.title,
        author: s.author ?? "",
        provenance,
        nominatedBy: m.name,
      });
    }
  }
  return out;
}

/** Normalized keys of every "already read" book — the hard exclusion set. Each title is added
 * with and without its leading article so "Scout Mindset" can't dodge "The Scout Mindset". */
export function exclusionKeys(members: Member[]): Set<string> {
  const keys = new Set<string>();
  for (const m of members) {
    for (const b of m.alreadyRead) addExclusion(keys, b.title);
  }
  return keys;
}

/** The full hard-exclusion set: every member's already-read list plus the group's past reads. */
export function buildExclusionSet(members: Member[], history: PastRead[] | undefined): Set<string> {
  const keys = exclusionKeys(members);
  for (const h of history ?? []) addExclusion(keys, h.title);
  return keys;
}

function addExclusion(keys: Set<string>, title: string): void {
  const key = titleKey({ title });
  if (!key) return;
  keys.add(key);
  keys.add(stripArticle(key));
}

/** True if a title hits the exclusion set under any variant — a subtitled entry ("The Scout
 * Mindset: Why Some People See…") or an article-dropped one ("Scout Mindset") must match a
 * bare "The Scout Mindset" exclusion. */
export function isExcluded(title: string, excluded: Set<string>): boolean {
  return titleVariants(title).some((v) => excluded.has(v) || excluded.has(stripArticle(v)));
}

/**
 * Claude's raw candidates → `claude_own_pick` candidates, dropping: blanks, anything already
 * seeded, anything in the exclusion set, and duplicates within the batch.
 */
export function filterClaudeCandidates(
  raw: ReadonlyArray<{ title: string; author: string }>,
  seeded: Candidate[],
  excluded: Set<string>,
): Candidate[] {
  const seen = new Set<string>(seeded.map((c) => titleKey(c)));
  const out: Candidate[] = [];
  for (const r of raw) {
    const title = (r.title ?? "").trim();
    if (!title) continue;
    const key = titleKey({ title });
    if (!key || seen.has(key) || isExcluded(title, excluded)) continue;
    seen.add(key);
    out.push({
      id: shortId("c"),
      title,
      author: (r.author ?? "").trim(),
      provenance: "claude_own_pick",
      nominatedBy: null,
    });
  }
  return out;
}
