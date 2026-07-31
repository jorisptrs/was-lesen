import { describe, expect, it } from "vitest";
import { parseMembers } from "../src/domain/members";

describe("parseMembers", () => {
  it("parses a single Name: paragraph block", () => {
    const [m] = parseMembers("Alice: slow literary novels about place and memory");
    expect(m).toEqual({
      name: "Alice",
      paragraph: "slow literary novels about place and memory",
      suggestions: [],
      alreadyRead: [],
      loved: [],
    });
  });

  it("separates members on blank lines", () => {
    const members = parseMembers("Alice: literary fiction\n\nBen: hard sci-fi");
    expect(members.map((m) => m.name)).toEqual(["Alice", "Ben"]);
    expect(members.map((m) => m.paragraph)).toEqual(["literary fiction", "hard sci-fi"]);
  });

  it("joins multi-line paragraphs", () => {
    const [m] = parseMembers("Ben: sci-fi that takes ideas seriously\nnothing over 400 pages");
    expect(m!.paragraph).toBe("sci-fi that takes ideas seriously nothing over 400 pages");
  });

  it("routes loved / read / suggest sublines into book lists", () => {
    const [m] = parseMembers(
      [
        "Alice: place and memory",
        "loved: Housekeeping — Marilynne Robinson; The Rings of Saturn by W.G. Sebald",
        "read: Ulysses",
        "suggest: The Blue Flower — Penelope Fitzgerald",
      ].join("\n"),
    );
    expect(m!.loved).toEqual([
      { title: "Housekeeping", author: "Marilynne Robinson" },
      { title: "The Rings of Saturn", author: "W.G. Sebald" },
    ]);
    expect(m!.alreadyRead).toEqual([{ title: "Ulysses" }]);
    expect(m!.suggestions).toEqual([{ title: "The Blue Flower", author: "Penelope Fitzgerald" }]);
    expect(m!.paragraph).toBe("place and memory");
  });

  it("auto-names a block that has no Name: prefix", () => {
    const [m] = parseMembers("I want big ambitious systems books.\nNothing too dry.");
    expect(m!.name).toBe("Member 1");
    expect(m!.paragraph).toBe("I want big ambitious systems books. Nothing too dry.");
  });

  it("does not treat a keyword-looking name as a member name", () => {
    // A leading `loved:` with no name should not become a member called "loved".
    const [m] = parseMembers("loved: Dune");
    expect(m!.name).toBe("Member 1");
  });

  it("returns [] for empty input", () => {
    expect(parseMembers("   \n\n  ")).toEqual([]);
  });
});
