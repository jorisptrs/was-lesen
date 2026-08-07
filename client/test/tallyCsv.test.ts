import { describe, expect, it } from "vitest";
import {
  buildMembersText,
  paceStatsFrom,
  isFeedbackCsv,
  parseCsv,
  parseMembersText,
  parsePaceRange,
  stripSkippedConstraints,
  tallyCsvToMembersText,
} from "../src/lib/tallyCsv";

const FEEDBACK_CSV = [
  '"What\'s your name?","Which book did we read?","Did you finish it?","How satisfied were you with the pick? (1-5)","One line of feedback (optional)"',
  'Mara,Thinking in Systems,Finished,4,"insightful but a bit dry"',
  "Sasha,Thinking in Systems,Some of it,2,too abstract for me",
  "Silke,Thinking in Systems,Mostly,5,",
].join("\n");

describe("stripSkippedConstraints", () => {
  const constraints = [
    "Mara: German or English please.",
    "Sasha: as well as anything from Russian classics",
    "everyone reads on paper", // no name prefix → group-wide
  ].join("\n");

  it("drops the skipped member's lines, keeps everyone else's and group-wide lines", () => {
    const out = stripSkippedConstraints(constraints, ["Sasha"]);
    expect(out).toContain("Mara: German or English");
    expect(out).toContain("everyone reads on paper");
    expect(out).not.toContain("Russian classics");
  });

  it("matches names case-insensitively and is a no-op with no skips", () => {
    expect(stripSkippedConstraints(constraints, ["sasha"])).not.toContain("Russian classics");
    expect(stripSkippedConstraints(constraints, [])).toBe(constraints);
  });
});

describe("hedged entries pass through the CSV split untouched (Stage-0 LLM cleans them)", () => {
  it("does NOT strip hedge-like words — they can be real title words", () => {
    const header = '"What\'s your name?","#pages you\'d realistically read per two weeks?","What are you interested in reading (may be seen by the others)?","Concretely","List books...","List books... (2)","Anything else?"';
    const csv = header + "\n" + '"Nova","75","Big ideas.","off top of my head probably Sapiens, Maybe You Should Talk to Someone","","",""\n';
    const { members } = tallyCsvToMembersText(csv);
    expect(members[0]!.loved).toEqual(["off top of my head probably Sapiens", "Maybe You Should Talk to Someone"]);
  });
});

describe("isFeedbackCsv", () => {
  // The feedback import is gone — past reads are typed into the panel. This check only has to
  // RECOGNISE the old export so it isn't parsed as an intake, which would invent members out of
  // feedback rows.
  it("recognises the post-read export and lets the intake through", () => {
    expect(isFeedbackCsv(FEEDBACK_CSV)).toBe(true);
    expect(isFeedbackCsv('"What\'s your name?","What are you interested in reading?"\nA,books')).toBe(false);
  });
});

describe("parseCsv", () => {
  it("handles quoted fields, embedded commas and newlines, and escaped quotes", () => {
    const csv = 'a,b,c\n"x,1","line1\nline2","he said ""hi"""\n';
    const rows = parseCsv(csv);
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["x,1", "line1\nline2", 'he said "hi"'],
    ]);
  });

  it("strips a BOM", () => {
    expect(parseCsv("﻿name\nAlice")).toEqual([["name"], ["Alice"]]);
  });
});

describe("tallyCsvToMembersText", () => {
  const header =
    '"What\'s your name?","#pages you\'d realistically read per two weeks?",' +
    '"What are you interested in reading (may be seen by the others)?","Concretely",' +
    '"List books...","List books... (2)","Anything else?"';

  it("maps Tally columns by header name into Name: blocks with loved/suggest lines", () => {
    const csv =
      header +
      "\n" +
      '"Alice","50-100","Philosophy of mind and ethics.","The Selfish Gene, Moral Tribes",' +
      '"Dune, Neuromancer","The Book of Why","prefer short books"\n';
    const { text, count, paceHint, constraints } = tallyCsvToMembersText(csv);
    expect(count).toBe(1);
    expect(paceHint).toBe(75); // midpoint of "50-100" (planning pace = median of midpoints)
    expect(text).toContain("Alice: Philosophy of mind and ethics.");
    // Mapping: "Concretely" -> loved; "List books..." -> already-read; "List books... (2)" -> suggest.
    expect(text).toContain("loved: The Selfish Gene; Moral Tribes");
    expect(text).toContain("read: Dune; Neuromancer");
    expect(text).toContain("suggest: The Book of Why");
    // "Anything else?" becomes a group-level constraint line, not paragraph filler.
    expect(text).not.toContain("prefer short books");
    expect(constraints).toBe("Alice: prefer short books");
  });

  it("auto-names blank names and takes the median pace across members", () => {
    const csv =
      header +
      "\n" +
      '"","30","Poetry.","","","",""\n' +
      '"Ben","90","Sci-fi.","","","",""\n' +
      '"Cara","150","History.","","","",""\n';
    const { text, count, paceHint } = tallyCsvToMembersText(csv);
    expect(count).toBe(3);
    expect(text).toContain("Member 1: Poetry.");
    expect(paceHint).toBe(90); // median of 30, 90, 150
  });

  it("strips bullet/numbering prefixes and keeps commas inside titles of line-formatted lists", () => {
    const csv =
      header +
      "\n" +
      '"Ana","80","Big ideas.","- The Precipice\n- Scout Mindset","","1. A Brief History of Time by Stephen Hawking\n2) Superintelligence: Paths, Dangers, Strategies",""\n';
    const { text } = tallyCsvToMembersText(csv);
    expect(text).toContain("loved: The Precipice; Scout Mindset");
    // line-formatted → the commas in "Paths, Dangers, Strategies" do NOT split the title
    expect(text).toContain("suggest: A Brief History of Time by Stephen Hawking; Superintelligence: Paths, Dangers, Strategies");
    expect(text).not.toContain("- The");
    expect(text).not.toContain("1.");
  });

  it("computes the pace distribution (midpoint median, slowest by lower bound)", () => {
    const csv =
      header +
      "\n" +
      '"Ana","50-100","Poetry.","","","",""\n' +
      '"Ben","100","Sci-fi.","","","",""\n' +
      '"Cara","not sure","History.","","","",""\n';
    const { paceStats, paceHint } = tallyCsvToMembersText(csv);
    expect(paceStats).not.toBeNull();
    expect(paceStats!.min).toBe(50); // Ana's lower bound
    expect(paceStats!.max).toBe(100);
    expect(paceStats!.slowest).toBe("Ana");
    expect(paceStats!.median).toBe(paceHint); // midpoints [75, 100] → 87.5 → 88
    expect(paceHint).toBe(88);
  });

  it("parses the SIMPLER form the group now fills in (no pace column)", () => {
    // Regression pin on the canonical 2026-08 intake export, headers verbatim (Tally truncates
    // them to "List books..."). No "#pages" question → paceHint/paceStats null and the pace
    // graph stays hidden; the run then falls back to the 180 p/2wk default.
    const simple =
      '"Submission ID","Respondent ID","Submitted at","What\'s your name?","What are you interested in reading?",' +
      '"Concretely","List books...","List books... (2)","Anything else?"\n' +
      '"X51KPE4","rjpPDQp","2026-08-06 05:56:31","Jojo","I like trains","Trains","Nontrainland","trainy","Hihi"\n';
    const { text, count, paceHint, paceStats, constraints, members } = tallyCsvToMembersText(simple);
    expect(count).toBe(1);
    expect(paceHint).toBeNull();
    expect(paceStats).toBeNull();
    expect(text).toContain("Jojo: I like trains");
    expect(members[0]).toMatchObject({ loved: ["Trains"], read: ["Nontrainland"], suggest: ["trainy"] });
    expect(constraints).toBe("Jojo: Hihi");
  });

  it("skips fully empty responses and rejects non-Tally CSVs", () => {
    const withEmpty = header + "\n" + '"","","","","","",""\n' + '"Ben","90","Sci-fi.","","","",""\n';
    expect(tallyCsvToMembersText(withEmpty).count).toBe(1);
    expect(() => tallyCsvToMembersText("foo,bar\n1,2")).toThrow();
  });
});

describe("parseMembersText / buildMembersText round-trip", () => {
  it("parses the Name: block format into structured members", () => {
    const text = "Alice: loves place and memory\n  loved: Housekeeping; The Rings of Saturn\n  read: Ulysses\n  suggest: The Blue Flower\n\nBen: sci-fi that takes ideas seriously";
    const members = parseMembersText(text);
    expect(members).toHaveLength(2);
    expect(members[0]!.name).toBe("Alice");
    expect(members[0]!.paragraph).toBe("loves place and memory");
    expect(members[0]!.loved).toEqual(["Housekeeping", "The Rings of Saturn"]);
    expect(members[0]!.read).toEqual(["Ulysses"]);
    expect(members[0]!.suggest).toEqual(["The Blue Flower"]);
    expect(members[1]!.name).toBe("Ben");
    expect(members[1]!.loved).toEqual([]);
  });

  it("round-trips (build → parse → build is stable) and filters blank list entries", () => {
    const members = [
      { name: "Ana", paragraph: "big ideas", loved: ["A Book", "", "Another"], read: [], suggest: ["X — Y"] },
    ];
    const text = buildMembersText(members);
    expect(text).toContain("loved: A Book; Another"); // blank dropped
    expect(buildMembersText(parseMembersText(text))).toBe(text);
  });
});

describe("parsePaceRange", () => {
  it("parses ranges, singles, and free text", () => {
    expect(parsePaceRange("50-100")).toEqual({ low: 50, high: 100 });
    expect(parsePaceRange("100")).toEqual({ low: 100, high: 100 });
    expect(parsePaceRange("not sure, depends on the book")).toBeNull();
  });
});

describe("multi-book split (Author: Title. Author: Title.)", () => {
  const header =
    '"What\'s your name?","#pages you\'d realistically read per two weeks?",' +
    '"What are you interested in reading (may be seen by the others)?","Concretely",' +
    '"List books...","List books... (2)","Anything else?"';
  it("splits a period-separated run of Name: Title entries into separate books", () => {
    const csv =
      header + "\n" +
      '"Karla","50","Philosophy.","Rebecca Solnit: A Field Guide to Getting Lost. Wolfram Eilenberger: Time of the Magicians. Doug Saunders: Arrival Cities.","","",""\n';
    const { members } = tallyCsvToMembersText(csv);
    expect(members[0]!.loved).toEqual([
      "Rebecca Solnit: A Field Guide to Getting Lost",
      "Wolfram Eilenberger: Time of the Magicians",
      "Doug Saunders: Arrival Cities",
    ]);
  });
  it("does not split a 'Title. Subtitle' that lacks an Author: prefix", () => {
    const csv = header + "\n" + '"Ana","50","Big ideas.","Sapiens. A Brief History of Humankind","","",""\n';
    const { members } = tallyCsvToMembersText(csv);
    expect(members[0]!.loved).toEqual(["Sapiens. A Brief History of Humankind"]);
  });
});

describe("belief-to-stress-test column (intake)", () => {
  const header =
    '"What\'s your name?","#pages you\'d realistically read per two weeks?","What are you interested in reading (may be seen by the others)?","Concretely","List books...","List books... (2)","Anything else?","One belief you hold that you\'d like stress-tested — or a question where you suspect you might be wrong (optional)"';

  it("appends the belief to the member's paragraph in their own words", () => {
    const csv = header + "\n" + '"Nova","75","Big ideas about society.","","","","","I suspect markets fix most things"\n';
    const { members } = tallyCsvToMembersText(csv);
    expect(members[0]!.paragraph).toBe(
      "Big ideas about society. Belief I'd like stress-tested: I suspect markets fix most things",
    );
  });

  it("ignores empty and no-answer values", () => {
    const csv =
      header +
      "\n" +
      '"Nova","75","Big ideas.","","","","",""\n' +
      '"Mara","50","History.","","","","","none"\n' +
      '"Zoë","50","Ecology.","","","","","N/A"\n';
    const { members } = tallyCsvToMembersText(csv);
    expect(members.map((m) => m.paragraph)).toEqual(["Big ideas.", "History.", "Ecology."]);
  });

  it("keeps a belief-only response as a member", () => {
    const csv = header + "\n" + '"Nova","","","","","","","AI progress will slow down"\n';
    const { members } = tallyCsvToMembersText(csv);
    expect(members).toHaveLength(1);
    expect(members[0]!.paragraph).toBe("Belief I'd like stress-tested: AI progress will slow down");
  });

  it("leaves detection and old CSVs (no belief column) unchanged", () => {
    const old = '"What\'s your name?","What are you interested in reading?"\nA,books';
    expect(isFeedbackCsv(old)).toBe(false);
    expect(tallyCsvToMembersText(old).members[0]!.paragraph).toBe("books");
  });
});

describe("paceStatsFrom (skip-aware recompute)", () => {
  const rows = [
    { name: "Nova", low: 50, high: 100 },
    { name: "Mara", low: 150, high: 200 },
    { name: "Zoë", low: 100, high: 150 },
  ];
  it("aggregates min/median/max and names the slowest", () => {
    const s = paceStatsFrom(rows)!;
    expect([s.min, s.max, s.slowest]).toEqual([50, 200, "Nova"]);
    expect(s.median).toBe(125); // midpoints 75/175/125 → sorted 75,125,175
  });
  it("recomputes when the slowest member is filtered out (skipped)", () => {
    const s = paceStatsFrom(rows.filter((r) => r.name !== "Nova"))!;
    expect([s.min, s.slowest, s.median]).toEqual([100, "Zoë", 150]);
  });
  it("is not dragged up by one very fast reader", () => {
    // Real intake: one member answered 600 pages/2wk while everyone else was 50–150.
    // A mean would suggest 195 as the group default and halve every session estimate.
    const s = paceStatsFrom([
      { name: "A", low: 50, high: 50 },
      { name: "B", low: 50, high: 100 },
      { name: "C", low: 100, high: 100 },
      { name: "D", low: 150, high: 150 },
      { name: "E", low: 600, high: 600 },
    ])!;
    expect(s.median).toBe(100); // midpoints 50,75,100,150,600
    expect(s.max).toBe(600); // the outlier still shows in the spread
  });
  it("averages the two middle midpoints for an even member count", () => {
    const s = paceStatsFrom([
      { name: "A", low: 50, high: 100 }, // 75
      { name: "B", low: 100, high: 100 }, // 100
    ])!;
    expect(s.median).toBe(88); // (75 + 100) / 2 = 87.5 → 88
  });
  it("returns null for no rows", () => {
    expect(paceStatsFrom([])).toBeNull();
  });
});
