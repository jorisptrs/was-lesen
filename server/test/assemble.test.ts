import { describe, expect, it } from "vitest";
import type { Member } from "@sb/shared";
import { STAGE1_SYSTEMS, assembleStage1User, assembleFilterUser } from "../src/prompts/assemble";
import { GROUP_LENS_QUOTA, SOLO_LENS_QUOTA, lensAsk, lensQuota, lensesFor } from "../src/pipeline/stage1";

const member = (o: Partial<Member> & { name: string }): Member => ({
  name: o.name,
  paragraph: o.paragraph ?? "",
  suggestions: o.suggestions ?? [],
  alreadyRead: o.alreadyRead ?? [],
  loved: o.loved ?? [],
});

describe("lenses", () => {
  it("runs bridges + wildcards for a group, wildcards alone when solo", () => {
    expect(lensesFor(9)).toEqual(["bridges", "wildcards"]);
    expect(lensesFor(2)).toEqual(["bridges", "wildcards"]);
    // Nobody to bridge to — and the champions lens that used to cover this case is gone.
    expect(lensesFor(1)).toEqual(["wildcards"]);
  });

  it("asks each group lens for 12 and the lone solo lens for 16", () => {
    expect(lensQuota(9)).toBe(GROUP_LENS_QUOTA);
    expect(GROUP_LENS_QUOTA).toBe(12);
    expect(lensQuota(1)).toBe(SOLO_LENS_QUOTA);
    expect(SOLO_LENS_QUOTA).toBe(16);
  });

  it("puts the quota in the ask line", () => {
    expect(lensAsk("bridges", 9)).toContain("Propose 12 bridge books");
    expect(lensAsk("wildcards", 9)).toContain("Propose 12 wildcard books");
  });

  it("never says 'two members' in a solo run", () => {
    // A solo run has nobody to bridge to; the wording would be nonsense to the model.
    for (const lens of lensesFor(1)) {
      expect(lensAsk(lens, 1)).not.toMatch(/two different members/);
      expect(lensAsk(lens, 1)).toContain("16");
    }
  });
});

describe("STAGE1_SYSTEMS", () => {
  it("loads both frozen lens prompts, each with the shared no-invention rule", () => {
    expect(Object.keys(STAGE1_SYSTEMS)).toEqual(["bridges", "wildcards"]);
    for (const text of Object.values(STAGE1_SYSTEMS)) {
      expect(text.length).toBeGreaterThan(50);
      expect(text).toContain("Never invent titles or authors");
    }
    expect(STAGE1_SYSTEMS.bridges).toContain("BRIDGES");
    expect(STAGE1_SYSTEMS.wildcards).toContain("WILDCARDS");
  });

  it("stands wildcards on the same two-member basis as bridges, with a solo carve-out", () => {
    expect(STAGE1_SYSTEMS.wildcards).toContain("at least TWO different members");
    expect(STAGE1_SYSTEMS.wildcards).toContain("No canonical bestsellers");
    expect(STAGE1_SYSTEMS.wildcards).toContain("only ONE member");
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
      notes: [{ member: "Ben", rating: 3, note: "too dry" }],
    },
  ];
  const text = assembleStage1User(members, [{ title: "Dune", author: "Frank Herbert" }], history, lensAsk("bridges", 2));

  it("includes members, tastes, and loved books", () => {
    expect(text).toContain("Alice: place and memory");
    expect(text).toContain("loves: Housekeeping — Marilynne Robinson");
    expect(text).toContain("Ben: hard sci-fi");
  });

  it("includes exclusions, past reads, seeded pool, and the lens ask — but NO constraints", () => {
    expect(text).toContain("do NOT propose these");
    expect(text).toContain("Ulysses");
    expect(text).toContain("Past group reads");
    expect(text).toContain("Thinking in Systems (avg 3.8/5)");
    expect(text).toContain('Ben (3/5): "too dry"');
    expect(text).toContain("Dune — Frank Herbert");
    expect(text).toContain("Propose 12 bridge books"); // the quota is visible in the ask line
    expect(text).not.toContain("constraints"); // rules are enforced by the post-verify filter pass
  });

  it("generalizes feedback into taste evidence — only when there IS sentiment", () => {
    // Ratings/notes → the model is told to avoid close repeats of what failed (the panned
    // author) and favour neighbours of what landed, in BOTH stages (historyLines is shared).
    expect(text).toContain("TASTE EVIDENCE");
    expect(text).toContain("an author the group panned");
    // Bare titles carry no sentiment — they are exclusions, nothing more, no guidance.
    const bare = assembleStage1User(members, [], [{ title: "Some Old Pick" }], lensAsk("bridges", 2));
    expect(bare).toContain("Past group reads");
    expect(bare).not.toContain("TASTE EVIDENCE");
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
