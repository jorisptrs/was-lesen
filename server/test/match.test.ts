import { describe, expect, it } from "vitest";
import { authorMatches, dice, pickBestMatch, titleVariants, sameTitleOrdered } from "../src/books/match";
import type { OlDoc } from "../src/books/openLibrary";

const doc = (o: Partial<OlDoc>): OlDoc => ({ ...o });

describe("dice", () => {
  it("is 1 for identical and low for different", () => {
    expect(dice("housekeeping", "housekeeping")).toBe(1);
    expect(dice("housekeeping", "neuromancer")).toBeLessThan(0.2);
  });
});

describe("titleVariants / authorMatches", () => {
  it("splits an author-in-title on the colon", () => {
    expect(titleVariants("Ted Chiang: Stories of Your Life")).toContain("stories of your life");
  });
  it("matches an author by full or last name", () => {
    expect(authorMatches("Ursula K. Le Guin", ["Ursula K. Le Guin"])).toBe(true);
    expect(authorMatches("Helen Oyeyemi", ["Carmen Maria Machado"])).toBe(false);
  });
});

describe("pickBestMatch", () => {
  it("matches a real book by title + author", () => {
    const m = pickBestMatch("Housekeeping", "Marilynne Robinson", [
      doc({ title: "Housekeeping", author_name: ["Marilynne Robinson"], number_of_pages_median: 224 }),
    ]);
    expect(m?.doc.title).toBe("Housekeeping");
    expect(m?.authorMatched).toBe(true);
  });

  it("keeps a distinctive title but corrects a wrong author", () => {
    const m = pickBestMatch("Her Body and Other Parties", "Helen Oyeyemi", [
      doc({ title: "Her Body and Other Parties", author_name: ["Carmen Maria Machado"] }),
    ]);
    expect(m).not.toBeNull();
    expect(m?.authorMatched).toBe(false);
    expect(m?.doc.author_name?.[0]).toBe("Carmen Maria Machado");
  });

  it("rejects a generic title with a non-matching author", () => {
    const m = pickBestMatch("Arcadia", "Iain M. Banks", [
      doc({ title: "Arcadia", author_name: ["Tom Stoppard"] }),
      doc({ title: "Arcadia", author_name: ["Lauren Groff"] }),
    ]);
    expect(m).toBeNull();
  });

  it("prefers the canonical work over exact-titled junk editions (title-only)", () => {
    // Real Open Library shape: Rand's work carries an edition qualifier, while a study guide
    // and an audio release (credited to its narrator) have the exact bare title.
    const m = pickBestMatch("Atlas Shrugged", undefined, [
      doc({ title: "Atlas Shrugged (Centennial Ed. HC)", author_name: ["Ayn Rand"], edition_count: 84 }),
      doc({ title: "Atlas shrugged", author_name: ["Anne Williams"], edition_count: 2 }),
      doc({ title: "CliffsNotes on Rand's Atlas Shrugged", author_name: ["Andrew Bernstein"], edition_count: 6 }),
    ]);
    expect(m?.doc.author_name?.[0]).toBe("Ayn Rand");
  });

  it("rejects a hallucinated title (nothing similar)", () => {
    const m = pickBestMatch("In the Lake of the Dead Gods", "Koji Suzuki", [
      doc({ title: "Dune", author_name: ["Frank Herbert"] }),
    ]);
    expect(m).toBeNull();
  });

  it("handles the author-in-title artifact", () => {
    const m = pickBestMatch("Ted Chiang: Stories of Your Life and Others", "Ted Chiang", [
      doc({ title: "Stories of Your Life and Others", author_name: ["Ted Chiang"], number_of_pages_median: 281 }),
    ]);
    expect(m?.doc.title).toBe("Stories of Your Life and Others");
  });
});

describe("title inversions are different books (the Bennett case)", () => {
  const inverted = { title: "Intelligence: A Brief History", author_name: ["Anna T. Cianciolo", "Robert J. Sternberg"], edition_count: 5 };

  it("rejects an inverted title even at high dice similarity (author given, not matching)", () => {
    expect(pickBestMatch("A Brief History of Intelligence", "Max Bennett", [inverted])).toBeNull();
  });

  it("rejects an inverted title when no author was given", () => {
    expect(pickBestMatch("A Brief History of Intelligence", undefined, [inverted])).toBeNull();
  });

  it("still matches the inverted-looking doc when the AUTHOR agrees (same book, reworded listing)", () => {
    const doc = { title: "Intelligence: A Brief History", author_name: ["Max Bennett"], edition_count: 2 };
    const m = pickBestMatch("A Brief History of Intelligence", "Max Bennett", [doc]);
    expect(m?.authorMatched).toBe(true);
  });

  it("keeps the wrong-author hatch for the SAME title in the same order", () => {
    const doc = { title: "The Dawn of Everything", author_name: ["David Graeber", "David Wengrow"], edition_count: 30 };
    const m = pickBestMatch("The Dawn of Everything", "David Gruber", [doc]);
    expect(m).not.toBeNull();
    expect(m!.authorMatched).toBe(false); // author gets corrected from the catalog
  });

  it("tolerates one typo'd/plural token in the hatch, in order (title must still be ≥3 words)", () => {
    const doc = { title: "Thinking, Fast and Slow", author_name: ["Daniel Kahneman"], edition_count: 40 };
    expect(pickBestMatch("Thinking Fast and Sloww", "Someone Wrong", [doc])).not.toBeNull();
  });
});

describe("sameTitleOrdered", () => {
  it("ignores articles but not order", () => {
    expect(sameTitleOrdered("the selfish gene", "selfish gene")).toBe(true);
    expect(sameTitleOrdered("brief history of intelligence", "intelligence brief history of")).toBe(false);
  });
  it("rejects different token counts (subtitle divergence)", () => {
    expect(sameTitleOrdered("sapiens", "sapiens a brief history of humankind")).toBe(false);
  });
});
