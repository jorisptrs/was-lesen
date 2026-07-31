import { describe, expect, it } from "vitest";
import { titleCase } from "../src/lib/titleCase";

describe("titleCase", () => {
  it("capitalizes an all-lowercase title, keeping small words down", () => {
    expect(titleCase("the dawn of everything")).toBe("The Dawn of Everything");
    expect(titleCase("moral ambition")).toBe("Moral Ambition");
    expect(titleCase("a farewell to alms")).toBe("A Farewell to Alms");
  });

  it("capitalizes the last word even when small", () => {
    expect(titleCase("something to believe in")).toBe("Something to Believe In");
  });

  it("leaves already-cased words untouched (proper casing, acronyms)", () => {
    expect(titleCase("Gödel, Escher, Bach")).toBe("Gödel, Escher, Bach");
    expect(titleCase("the AI does not hate you")).toBe("The AI Does Not Hate You");
    expect(titleCase("Bird by Bird")).toBe("Bird by Bird");
  });

  it("capitalizes after a colon", () => {
    expect(titleCase("decoded: the science behind why we buy")).toBe("Decoded: The Science Behind Why We Buy");
  });

  it("keeps a correctly-cased title unchanged", () => {
    expect(titleCase("The Rise and Fall of the Great Powers")).toBe("The Rise and Fall of the Great Powers");
    expect(titleCase("Thinking in Systems")).toBe("Thinking in Systems");
  });
});
