import { describe, expect, it } from "vitest";
import type { Member } from "@sb/shared";
import { exclusionKeys, filterClaudeCandidates, isExcluded, seedLoved, seedNominations, seedPool } from "../src/pipeline/candidates";

const member = (o: Partial<Member> & { name: string }): Member => ({
  name: o.name,
  paragraph: o.paragraph ?? "",
  suggestions: o.suggestions ?? [],
  alreadyRead: o.alreadyRead ?? [],
  loved: o.loved ?? [],
});

describe("seedNominations", () => {
  it("turns suggestions into member_nomination candidates with attribution", () => {
    const out = seedNominations([member({ name: "Alice", suggestions: [{ title: "Dune", author: "Frank Herbert" }] })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      title: "Dune",
      author: "Frank Herbert",
      provenance: "member_nomination",
      nominatedBy: "Alice",
    });
    expect(out[0]!.id).toBeTruthy();
  });

  it("dedupes the same title across members (first wins)", () => {
    const out = seedNominations([
      member({ name: "Alice", suggestions: [{ title: "Dune" }] }),
      member({ name: "Ben", suggestions: [{ title: "dune" }] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.nominatedBy).toBe("Alice");
  });
});

describe("seedLoved", () => {
  it("turns liked books into member_loved candidates with attribution", () => {
    const out = seedLoved([member({ name: "Silke", loved: [{ title: "The Precipice", author: "Toby Ord" }] })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      title: "The Precipice",
      provenance: "member_loved",
      nominatedBy: "Silke",
    });
  });

  it("dedupes across members (first wins)", () => {
    const out = seedLoved([
      member({ name: "A", loved: [{ title: "Sapiens" }] }),
      member({ name: "B", loved: [{ title: "sapiens" }] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.nominatedBy).toBe("A");
  });
});

describe("exclusionKeys", () => {
  it("collects normalized already-read titles", () => {
    const keys = exclusionKeys([member({ name: "A", alreadyRead: [{ title: "The Left-Hand of Darkness" }] })]);
    expect(keys.has("the left hand of darkness")).toBe(true);
  });
});

describe("isExcluded", () => {
  it("matches a subtitled entry against a bare-title exclusion (the Scout Mindset case)", () => {
    const excluded = exclusionKeys([member({ name: "Joris", alreadyRead: [{ title: "The Scout Mindset" }] })]);
    expect(isExcluded("The Scout Mindset: Why Some People See Things Clearly and Others Don't", excluded)).toBe(true);
    expect(isExcluded("The Scout Mindset", excluded)).toBe(true);
    expect(isExcluded("The Righteous Mind", excluded)).toBe(false);
  });

  it("matches across a dropped or added leading article", () => {
    const excluded = exclusionKeys([member({ name: "J", alreadyRead: [{ title: "The Scout Mindset" }] })]);
    expect(isExcluded("Scout Mindset", excluded)).toBe(true); // lens proposed it without "The"
    const excluded2 = exclusionKeys([member({ name: "J", alreadyRead: [{ title: "Scout Mindset" }] })]);
    expect(isExcluded("The Scout Mindset", excluded2)).toBe(true);
  });
});

describe("filterClaudeCandidates", () => {
  it("drops dups vs seeded, exclusions, blanks, and within-batch dups", () => {
    const seeded = seedNominations([member({ name: "A", suggestions: [{ title: "Dune" }] })]);
    const excluded = exclusionKeys([member({ name: "A", alreadyRead: [{ title: "Ulysses" }] })]);
    const out = filterClaudeCandidates(
      [
        { title: "Dune", author: "Frank Herbert" }, // dup vs seeded
        { title: "Ulysses", author: "James Joyce" }, // excluded
        { title: "   ", author: "x" }, // blank
        { title: "The Overstory", author: "Richard Powers" },
        { title: "the overstory", author: "R. Powers" }, // within-batch dup
      ],
      seeded,
      excluded,
    );
    expect(out.map((c) => c.title)).toEqual(["The Overstory"]);
    expect(out[0]).toMatchObject({ provenance: "claude_own_pick", nominatedBy: null });
  });
});

describe("seedPool", () => {
  const members: Member[] = [
    {
      name: "Ana",
      paragraph: "",
      suggestions: [{ title: "Exhalation" }],
      alreadyRead: [{ title: "Dune" }],
      loved: [{ title: "Seeing Like a State" }, { title: "Exhalation" }, { title: "Dune" }],
    },
  ];

  it("keeps suggestions over the same book liked, and drops already-read ones", () => {
    const pool = seedPool(members, undefined);
    expect(pool.map((c) => c.title)).toEqual(["Exhalation", "Seeing Like a State"]);
    expect(pool[0]!.provenance).toBe("member_nomination"); // an explicit ask outranks a taste echo
  });

  it("drops a liked book the group has since read TOGETHER (the store's rows land here)", () => {
    const pool = seedPool(members, [{ title: "seeing like a state", notes: [] }]);
    expect(pool.map((c) => c.title)).toEqual(["Exhalation"]);
  });
});
