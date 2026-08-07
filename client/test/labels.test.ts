import { describe, expect, it } from "vitest";
import type { ScoredCard } from "@sb/shared";
import { provenanceBadge, summaryParas } from "../src/lib/labels";

const prov = (p: ScoredCard["provenance"], nominatedBy: string | null = null) =>
  provenanceBadge({ provenance: p, nominatedBy });

describe("provenanceBadge", () => {
  it("names the member behind a suggestion or a liked book", () => {
    expect(prov("member_nomination", "Ana").label).toBe("Suggested by Ana");
    expect(prov("member_loved", "Ben").label).toBe("Liked by Ben");
  });

  it("stays neutral for an unattributed manual add", () => {
    // Attributing a book to whoever happened to say it out loud is exactly the misattribution
    // this badge exists to prevent — "no one" has to stay readable as no one.
    const badge = prov("organizer_add");
    expect(badge.label).toBe("Added in the room");
    expect(badge.info).not.toMatch(/a member/);
  });

  it("names the member when a manual add IS attributed", () => {
    expect(prov("organizer_add", "Eve").label).toBe("Added for Eve");
  });

  it("says plainly when nothing human is behind a book", () => {
    expect(prov("claude_own_pick").label).toBe("Claude pick");
  });
});

describe("summaryParas", () => {
  it("splits the two-paragraph summary and tolerates a single newline", () => {
    expect(summaryParas("What it argues.\n\nHow readers take it.")).toHaveLength(2);
    expect(summaryParas("One.\nTwo.")).toHaveLength(2);
    expect(summaryParas("   ")).toEqual([]);
  });
});
