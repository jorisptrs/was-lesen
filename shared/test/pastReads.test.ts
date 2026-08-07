import { describe, expect, it } from "vitest";
import {
  GROUP_NOTE_AUTHOR,
  HISTORY_CAP,
  mergeHistory,
  parsePastReadsCsv,
  pastReadsToHistory,
  serializePastReadsCsv,
  toCsv,
  toPastReadRow,
  scoredMemberNames,
} from "../src";

const row = (title: string, over: Record<string, unknown> = {}) =>
  toPastReadRow({ title, addedAt: "2026-01-01T00:00:00.000Z", ...over }, "2026-08-06T00:00:00.000Z")!;

describe("toCsv", () => {
  it("quotes only what needs it", () => {
    expect(toCsv([["a", "b"]])).toBe("a,b\n");
  });

  it("quotes and escapes commas, quotes, newlines and edge whitespace", () => {
    // The note column is free text a human typed — this is the column that breaks naive writers.
    expect(toCsv([['dry, but useful', 'he said "no"', "two\nlines", " padded "]])).toBe(
      '"dry, but useful","he said ""no""","two\nlines"," padded "\n',
    );
  });
});

describe("past-reads CSV round-trip", () => {
  it("survives titles with commas, notes with quotes, and empty optional fields", () => {
    const rows = [
      row("Superintelligence: Paths, Dangers, Strategies", { author: "Nick Bostrom", rating: 3.7, note: 'we called it "grim"' }),
      row("Underland", { rating: null }),
    ];
    const back = parsePastReadsCsv(serializePastReadsCsv(rows));
    expect(back).toEqual(rows);
    expect(back[1]!.author).toBeUndefined();
  });

  it("round-trips a server-enriched cover URL", () => {
    const rows = [row("Dune", { coverUrl: "https://covers.openlibrary.org/b/id/12345-M.jpg" })];
    expect(parsePastReadsCsv(serializePastReadsCsv(rows))).toEqual(rows);
  });

  it("still reads a pre-cover five-column file, header-less included", () => {
    // coverUrl was appended LAST so existing files (and hand-typed header-less ones in the old
    // column order) keep parsing with addedAt at index 4.
    const old = parsePastReadsCsv("title,author,rating,note,addedAt\nDune,Herbert,4,,2026-01-01\n");
    expect(old[0]).toMatchObject({ title: "Dune", addedAt: "2026-01-01" });
    expect(old[0]!.coverUrl).toBeUndefined();
    const headerless = parsePastReadsCsv("Piranesi,Susanna Clarke,4,short and strange,2026-02-02\n");
    expect(headerless[0]).toMatchObject({ addedAt: "2026-02-02" });
  });

  it("reads a hand-edited file: reordered columns, missing ones, junk rating", () => {
    // The file is meant to be opened in a spreadsheet, so it must not be positional.
    const csv = 'note,title,rating\n"loved it",Piranesi,not a number\n';
    expect(parsePastReadsCsv(csv)).toEqual([
      { title: "Piranesi", rating: null, note: "loved it", addedAt: "" },
    ]);
  });

  it("falls back to the canonical column order when the header row is missing", () => {
    const rows = parsePastReadsCsv("Piranesi,Susanna Clarke,4,short and strange,2026-02-02\n");
    expect(rows[0]).toMatchObject({ title: "Piranesi", author: "Susanna Clarke", rating: 4 });
  });

  it("keeps the first of hand-edited duplicate titles and skips blank lines", () => {
    const rows = parsePastReadsCsv("title,author\nDune,Herbert\n\ndune,Someone Else\n");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.author).toBe("Herbert");
  });

  it("treats an empty or header-only file as no rows", () => {
    expect(parsePastReadsCsv("")).toEqual([]);
    expect(parsePastReadsCsv("title,author,rating,note,addedAt\n")).toEqual([]);
  });
});

describe("toPastReadRow", () => {
  it("clamps a rating to 5, keeps one decimal, and rejects a titleless row", () => {
    expect(toPastReadRow({ title: "A", rating: 9 }, "t")!.rating).toBe(5);
    expect(toPastReadRow({ title: "A", rating: "3.75" }, "t")!.rating).toBe(3.8);
    expect(toPastReadRow({ title: "   " }, "t")).toBeNull();
  });

  it("stamps addedAt when the caller has none", () => {
    expect(toPastReadRow({ title: "A" }, "2026-08-06")!.addedAt).toBe("2026-08-06");
  });
});

describe("pastReadsToHistory", () => {
  it("attributes the group note so historyLines renders it like a member's", () => {
    const [h] = pastReadsToHistory([row("Dune", { author: "Herbert", rating: 4, note: "argued all night" })]);
    expect(h).toEqual({
      title: "Dune",
      author: "Herbert",
      avgRating: 4,
      notes: [{ member: GROUP_NOTE_AUTHOR, rating: 4, note: "argued all night" }],
    });
  });

  it("emits no note lines for a book nobody commented on", () => {
    expect(pastReadsToHistory([row("Dune")])[0]!.notes).toEqual([]);
  });
});

describe("mergeHistory", () => {
  const store = pastReadsToHistory([row("Dune", { rating: 2 }), row("Piranesi", { rating: 5 })]);

  it("lets the request win on a title collision", () => {
    // A loaded run carries the history it was computed with, including the `finished` counts
    // the store doesn't keep.
    const req = [{ title: "dune", avgRating: 4, finished: "6/8 finished", notes: [] }];
    const { history } = mergeHistory(req, store);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ title: "dune", avgRating: 4, finished: "6/8 finished" });
  });

  it("passes the store through when the request has none", () => {
    expect(mergeHistory(undefined, store).history).toHaveLength(2);
  });

  it("caps the merge and reports what fell off", () => {
    // Past the cap the oldest entries stop being excluded — the count is what makes that visible.
    const many = pastReadsToHistory(Array.from({ length: 30 }, (_, i) => row(`Book ${i}`)));
    const { history, dropped } = mergeHistory(undefined, many);
    expect(history).toHaveLength(HISTORY_CAP);
    expect(dropped).toBe(30 - HISTORY_CAP);
  });
});

describe("scoredMemberNames", () => {
  const card = (members: string[]) => ({ perMember: members.map((m) => ({ member: m, fit: 7 })) });

  it("reads the map's own member set off the cards, in first-seen order", () => {
    expect(scoredMemberNames([card(["Ana", "Ben"]), card(["Ana", "Ben", "Cleo"])])).toEqual(["Ana", "Ben", "Cleo"]);
  });

  it("is empty for a map with no fits, so callers can fall back", () => {
    expect(scoredMemberNames([])).toEqual([]);
    expect(scoredMemberNames([{ perMember: [] }])).toEqual([]);
  });
});
