import type { Complexity, ReadingMode, ScoredCard } from "@sb/shared";

// Plain-language badge labels + the explanation shown in a click-toggled mini popover.
// Centralized so the sidebar, hover card, and present mode always agree.

export interface Badge {
  label: string;
  info: string;
}

export const COMPLEXITY: Record<Complexity, Badge> = {
  light: { label: "easy read", info: "Quick and accessible — easy pages, no prior knowledge needed." },
  moderate: { label: "medium read", info: "A general-audience book that rewards steady attention." },
  demanding: { label: "heavy read", info: "Dense or technical — expect slow, careful reading." },
};

export const MODE: Record<ReadingMode, Badge> = {
  comfort: { label: "safe bet", info: "Sits inside the group's usual taste — an easy yes." },
  stretch: { label: "wild card", info: "Outside the group's usual taste — picked to stretch it." },
};

export const EXPEDITION: Badge = {
  label: "long haul",
  info: "A big undertaking — long and/or hard; plan extra sessions.",
};

export const UNVERIFIED: Badge = {
  label: "needs verify",
  info: "No confident books-catalog match — double-check this edition exists before voting.",
};

export const AVG_FIT_INFO = "Mean of the per-member fit scores (1–10).";
export const DISCUSSABILITY_INFO = "How much a group can chew on together: themes, ambiguity, things worth arguing about (1–10).";

export function provenanceBadge(book: Pick<ScoredCard, "provenance" | "nominatedBy">): Badge {
  const who = book.nominatedBy ?? "a member";
  if (book.provenance === "member_nomination") {
    return { label: `Suggested by ${who}`, info: `${who} asked the group to read this.` };
  }
  if (book.provenance === "member_loved") {
    return {
      label: `Liked by ${who}`,
      info: `${who} names this among the books they've liked — personally vouched; they may be up for a re-read.`,
    };
  }
  return { label: "Claude pick", info: "Nominated by Claude from the group's tastes — no member suggested it." };
}

/** Split the two-paragraph summary for rendering ("\n\n" from Stage 3; tolerate single "\n"). */
export function summaryParas(summary: string): string[] {
  return summary
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}
