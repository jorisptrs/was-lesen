import { describe, expect, it } from "vitest";
import { normalizeTitle, parseBookList, parseBookRef, titleKey } from "../src/domain/bookref";

describe("parseBookRef", () => {
  it("splits on an em dash", () => {
    expect(parseBookRef("Housekeeping — Marilynne Robinson")).toEqual({
      title: "Housekeeping",
      author: "Marilynne Robinson",
    });
  });

  it("splits on a spaced hyphen", () => {
    expect(parseBookRef("Dune - Frank Herbert")).toEqual({ title: "Dune", author: "Frank Herbert" });
  });

  it('splits on " by "', () => {
    expect(parseBookRef("The Rings of Saturn by W.G. Sebald")).toEqual({
      title: "The Rings of Saturn",
      author: "W.G. Sebald",
    });
  });

  it("returns title-only when there is no author", () => {
    expect(parseBookRef("Ulysses")).toEqual({ title: "Ulysses" });
  });

  it("does not split a title that merely contains 'by' inside a word", () => {
    expect(parseBookRef("Bygone")).toEqual({ title: "Bygone" });
  });

  it("returns null for blank input", () => {
    expect(parseBookRef("   ")).toBeNull();
  });
});

describe("parseBookList", () => {
  it("splits on semicolons and newlines and drops blanks", () => {
    expect(parseBookList("Dune — Frank Herbert; Ulysses\n\nThe Blue Flower — Penelope Fitzgerald")).toEqual([
      { title: "Dune", author: "Frank Herbert" },
      { title: "Ulysses" },
      { title: "The Blue Flower", author: "Penelope Fitzgerald" },
    ]);
  });
});

describe("normalizeTitle / titleKey", () => {
  it("lowercases, strips accents and punctuation", () => {
    expect(normalizeTitle("Béloved: A Novel!")).toBe("beloved a novel");
  });

  it("titleKey matches across formatting differences", () => {
    expect(titleKey({ title: "The  Left-Hand  of Darkness" })).toBe(
      titleKey({ title: "the left hand of darkness" }),
    );
  });
});
