import { type Cluster, type MemberCoverage, type MemberFit, qualityOf, type ScoredCard, type SelectionMeta, type VerifiedBook } from "@sb/shared";

// Tuning constants — the "dry-run dial". Adjust after a real run to taste.
export const SELECTION = {
  QUALITY_MIN: 6.0, // quality threshold to be selected on merit (retuned down for the anchored
  // Stage-3 rubric, which scores honestly lower than the old free-form fits did)
  SERVE_FIT_MIN: 7, // a book "serves" a member at this fit or above
  FLOOR: 15, // never show fewer than this (pad below threshold if needed)
  TARGET: 20,
  CEILING: 25, // never show more than this on merit (coverage overrides can exceed it)
  NEUTRAL_FIT: 5, // fit assigned to a member the model didn't score
} as const;

/** Stage-3 fields merged onto a verified book, before the app computes avg / serves / selection. */
export interface ScoredInput extends VerifiedBook {
  clusterLabel: string;
  complexity: ScoredCard["complexity"];
  mode: ScoredCard["mode"];
  summary: string;
  discussability: number;
  rationale: string;
  expedition: boolean;
  perMember: MemberFit[];
}

export interface SelectionResult {
  books: ScoredCard[];
  clusters: Cluster[];
  coverage: MemberCoverage[];
  selection: SelectionMeta;
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));
const quality = (b: ScoredCard): number => qualityOf(b.avgFit, b.discussability, b.pageCount);
const fitFor = (b: ScoredCard, member: string): number =>
  b.perMember.find((p) => p.member === member)?.fit ?? SELECTION.NEUTRAL_FIT;

/** Normalise one scored input: clamp fits, fill missing members, compute avgFit + servesMost. */
function finalize(input: ScoredInput, memberNames: string[]): ScoredCard {
  const given = new Map(input.perMember.map((p) => [p.member, clamp(p.fit, 1, 10)]));
  const perMember: MemberFit[] = memberNames.map((m) => ({ member: m, fit: given.get(m) ?? SELECTION.NEUTRAL_FIT }));
  const avgFit = perMember.length ? perMember.reduce((s, p) => s + p.fit, 0) / perMember.length : SELECTION.NEUTRAL_FIT;
  const discussability = clamp(input.discussability, 1, 10);
  const servesMost = perMember
    .filter((p) => p.fit >= SELECTION.SERVE_FIT_MIN)
    .sort((a, z) => z.fit - a.fit)
    .map((p) => p.member);
  return {
    ...input,
    discussability,
    perMember,
    avgFit: Math.round(avgFit * 10) / 10,
    servesMost,
    belowThreshold: qualityOf(avgFit, discussability, input.pageCount) < SELECTION.QUALITY_MIN,
    pulledInFor: null,
  };
}

/**
 * Select the books to show. Average fit drives rank; discussability lifts divisive books; a
 * quality threshold (not a fixed top-N) cuts the tail within a floor/ceiling; and "every member
 * served by ≥2" pulls in a below-threshold book for a quiet member (coverage > ceiling). Solo
 * mode uncaps the display. All arithmetic is here — never in the model.
 */
export function selectBooks(inputs: ScoredInput[], memberNames: string[], soloMode: boolean): SelectionResult {
  const all = inputs.map((b) => finalize(b, memberNames)).sort((a, z) => quality(z) - quality(a));

  const quietMemberPulls: { member: string; bookId: string }[] = [];
  const unservableMembers: string[] = [];
  let selected: ScoredCard[];

  if (soloMode) {
    const passing = all.filter((b) => quality(b) >= SELECTION.QUALITY_MIN);
    selected = passing.length ? passing : all.slice(); // uncapped; show all if none pass
  } else {
    const passing = all.filter((b) => quality(b) >= SELECTION.QUALITY_MIN);
    selected = passing.slice(0, SELECTION.CEILING);
    if (selected.length < SELECTION.FLOOR) {
      for (const b of all) {
        if (selected.length >= SELECTION.FLOOR) break;
        if (!selected.includes(b)) selected.push(b);
      }
    }

    // "Every member served by ≥2": pull in a quiet member's best serving book(s).
    const inSel = new Set(selected.map((b) => b.id));
    for (const member of memberNames) {
      let count = selected.filter((b) => fitFor(b, member) >= SELECTION.SERVE_FIT_MIN).length;
      if (count >= 2) continue;
      const candidates = all
        .filter((b) => !inSel.has(b.id) && fitFor(b, member) >= SELECTION.SERVE_FIT_MIN)
        .sort((a, z) => fitFor(z, member) - fitFor(a, member));
      for (const b of candidates) {
        if (count >= 2) break;
        b.pulledInFor = member;
        b.belowThreshold = quality(b) < SELECTION.QUALITY_MIN;
        selected.push(b);
        inSel.add(b.id);
        quietMemberPulls.push({ member, bookId: b.id });
        count++;
      }
      if (count === 0) unservableMembers.push(member);
    }
  }

  selected.sort((a, z) => quality(z) - quality(a));

  const clusterMap = new Map<string, string[]>();
  for (const b of selected) {
    const arr = clusterMap.get(b.clusterLabel) ?? [];
    arr.push(b.id);
    clusterMap.set(b.clusterLabel, arr);
  }
  const clusters: Cluster[] = [...clusterMap.entries()].map(([label, bookIds]) => ({ label, bookIds }));

  const coverage: MemberCoverage[] = memberNames.map((member) => {
    const bs = selected.filter((b) => fitFor(b, member) >= SELECTION.SERVE_FIT_MIN);
    return { member, served: bs.length, bookIds: bs.map((b) => b.id) };
  });

  const selection: SelectionMeta = {
    threshold: SELECTION.QUALITY_MIN,
    target: SELECTION.TARGET,
    floor: SELECTION.FLOOR,
    ceiling: SELECTION.CEILING,
    kept: selected.length,
    quietMemberPulls,
    unservableMembers: [...new Set(unservableMembers)],
  };

  return { books: selected, clusters, coverage, selection };
}
