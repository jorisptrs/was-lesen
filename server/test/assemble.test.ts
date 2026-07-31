import { describe, expect, it } from "vitest";
import type { Member } from "@sb/shared";
import { STAGE1_SYSTEMS, assembleStage1User, assembleFilterUser } from "../src/prompts/assemble";
import { championsQuota, lensAsk } from "../src/pipeline/stage1";

const member = (o: Partial<Member> & { name: string }): Member => ({
  name: o.name,
  paragraph: o.paragraph ?? "",
  suggestions: o.suggestions ?? [],
  alreadyRead: o.alreadyRead ?? [],
  loved: o.loved ?? [],
});

describe("championsQuota", () => {
  it("is 2 per member in a real group, more for tiny ones", () => {
    expect(championsQuota(8)).toBe(2);
    expect(championsQuota(4)).toBe(2);
    expect(championsQuota(3)).toBe(3);
    expect(championsQuota(2)).toBe(4);
    expect(championsQuota(1)).toBe(8);
  });
});

describe("STAGE1_SYSTEMS", () => {
  it("loads all three frozen lens prompts, each with the shared no-invention rule", () => {
    for (const text of Object.values(STAGE1_SYSTEMS)) {
      expect(text.length).toBeGreaterThan(50);
      expect(text).toContain("Never invent titles or authors");
    }
    expect(STAGE1_SYSTEMS.champions).toContain("PERSONAL CHAMPIONS");
    expect(STAGE1_SYSTEMS.bridges).toContain("BRIDGES");
    expect(STAGE1_SYSTEMS.wildcards).toContain("WILDCARDS");
  });
});

describe("assembleStage1User", () => {
  const members = [
    member({
      name: "Alice",
      paragraph: "place and memory",
      loved: [{ title: "Housekeeping", author: "Marilynne Robinson" }],
      alreadyRead: [{ title: "Ulysses" }],
    }),
    member({ name: "Ben", paragraph: "hard sci-fi" }),
  ];
  const history = [
    {
      title: "Thinking in Systems",
      avgRating: 3.8,
      finished: "5/8 finished",
      notes: [{ member: "Ben", rating: 3, note: "too dry" }],
    },
  ];
  const text = assembleStage1User(members, [{ title: "Dune", author: "Frank Herbert" }], history, lensAsk("champions", 2));

  it("includes members, tastes, and loved books", () => {
    expect(text).toContain("Alice: place and memory");
    expect(text).toContain("loves: Housekeeping — Marilynne Robinson");
    expect(text).toContain("Ben: hard sci-fi");
  });

  it("includes exclusions, past reads, seeded pool, and the lens ask — but NO constraints", () => {
    expect(text).toContain("do NOT propose these");
    expect(text).toContain("Ulysses");
    expect(text).toContain("Past group reads");
    expect(text).toContain("Thinking in Systems (avg 3.8/5; 5/8 finished)");
    expect(text).toContain('Ben (3/5): "too dry"');
    expect(text).toContain("Dune — Frank Herbert");
    expect(text).toContain("exactly 4 books"); // champions quota for 2 members
    expect(text).not.toContain("constraints"); // rules are enforced by the post-verify filter pass
  });
});

describe("assembleFilterUser", () => {
  it("lists the rules and the books with their ids", () => {
    const text = assembleFilterUser("no Russian classics\nGerman or English only", [
      {
        id: "c_1", title: "Dead Souls", author: "Nikolai Gogol", provenance: "claude_own_pick",
        nominatedBy: null, status: "verified", year: 1842, pageCount: 432,
        pageCountSource: "openlibrary_median", coverUrl: null, olWorkKey: null, matchConfidence: 1,
      },
    ]);
    expect(text).toContain("no Russian classics");
    expect(text).toContain("[c_1] Dead Souls — Nikolai Gogol (1842, 432p)");
    expect(text).toContain("CLEARLY violate");
  });
});
