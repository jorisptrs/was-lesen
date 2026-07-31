// Live eval for the Stage-0 normalize prompt: a fixed set of adversarial book-list entries with
// expected outputs, run against /api/normalize (server must be up). Costs ~$0.01/run on Haiku.
// The mocks are mixed into a realistic-size payload — model behavior at 6 entries differs from
// behavior at 60, so filler entries pad the batch to full size.
//
//   npx tsx scripts/eval-normalize.mts [runs=2]

interface Case {
  entry: string;
  /** Expected kind, and (for books) the expected title. `null` title = any non-empty is fine. */
  expect: { kind: "book" | "not_a_book" | "rule"; title?: string | null };
  note: string;
}

const CASES: Case[] = [
  // Leading hedges → strip to the title
  { entry: "off top of my head probably Sapiens", expect: { kind: "book", title: "Sapiens" }, note: "stacked leading hedge" },
  { entry: "maybe The Overstory?", expect: { kind: "book", title: "The Overstory" }, note: "hedge + question mark" },
  { entry: "I think Thinking, Fast and Slow", expect: { kind: "book", title: "Thinking, Fast and Slow" }, note: "hedge before comma title" },
  { entry: "perhaps Der Steppenwolf", expect: { kind: "book", title: "Steppenwolf" }, note: "hedge + German title (remap ok)" },
  // Trailing / mid hedges and asides
  { entry: "Sapiens probably", expect: { kind: "book", title: "Sapiens" }, note: "trailing hedge" },
  { entry: "The Overstory (didn't finish it)", expect: { kind: "book", title: "The Overstory" }, note: "parenthetical aside" },
  { entry: "Sapiens (or was it Homo Deus?)", expect: { kind: "book", title: null }, note: "self-doubt aside — either title acceptable" },
  // Hedge + author
  { entry: "probably Sapiens by Harari", expect: { kind: "book", title: "Sapiens" }, note: "hedge + author" },
  { entry: "I guess anything by Le Guin, say The Dispossessed", expect: { kind: "book", title: "The Dispossessed" }, note: "preference + named title → title wins" },
  // REAL titles that start with hedge-like words — must stay whole
  { entry: "Maybe You Should Talk to Someone", expect: { kind: "book", title: "Maybe You Should Talk to Someone" }, note: "real title starting 'Maybe'" },
  { entry: "I Think You'll Find It's a Bit More Complicated Than That", expect: { kind: "book", title: "I Think You'll Find It's a Bit More Complicated Than That" }, note: "real title starting 'I Think'" },
  { entry: "Something Like an Autobiography", expect: { kind: "book", title: "Something Like an Autobiography" }, note: "real title starting 'Something Like'" },
  { entry: "Anything Is Possible", expect: { kind: "book", title: "Anything Is Possible" }, note: "real title starting 'Anything'" },
  { entry: "Perhaps the Stars", expect: { kind: "book", title: "Perhaps the Stars" }, note: "real title starting 'Perhaps'" },
  // Prose / rules — must NOT become books
  { entry: "don't have a good list ready, sorry!", expect: { kind: "not_a_book" }, note: "pure filler" },
  { entry: "as well as anything from Russian classics", expect: { kind: "rule" }, note: "pure preference → rule" },
  { entry: "no books over 600 pages please", expect: { kind: "rule" }, note: "explicit limit → rule" },
  // Typos with hedges
  { entry: "maybe Kinds of Mind by Dennett", expect: { kind: "book", title: "Kinds of Minds" }, note: "hedge + typo fix" },
];

// Realistic padding so the batch is full-size (behavior at 6 entries ≠ behavior at 60).
const FILLER = [
  "The Lean Startup — Eric Ries", "Zero to One — Peter Thiel", "Dune — Frank Herbert",
  "The Three-Body Problem", "Snow Crash — Neal Stephenson", "The Signal and the Noise",
  "Predictably Irrational — Dan Ariely", "The Soul of a New Machine", "Hackers — Steven Levy",
  "The Innovators — Walter Isaacson", "Gödel, Escher, Bach", "The Pragmatic Programmer",
  "High Output Management — Andrew Grove", "The Selfish Gene", "The Dawn of Everything",
  "Braiding Sweetgrass", "The Book of Why", "Reasons and Persons", "Superintelligence",
  "The Ministry for the Future", "Debt: The First 5,000 Years", "The Righteous Mind",
  "Homo Deus — Yuval Noah Harari", "21 Lessons for the 21st Century", "Antifragile",
  "Thinking in Systems — Donella Meadows", "The Structure of Scientific Revolutions",
  "Seeing Like a State", "The Second Sex", "A Farewell to Alms",
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const runs = Number(process.argv[2] ?? 2);
let totalPass = 0;
let totalCases = 0;

for (let run = 1; run <= runs; run++) {
  // Interleave cases among filler at stable-but-spread offsets.
  const entries: (string | null)[] = [...FILLER];
  const caseIndex = new Map<number, Case>();
  CASES.forEach((c, i) => {
    const at = Math.min(entries.length, Math.floor((i * (entries.length + CASES.length)) / CASES.length));
    entries.splice(at, 0, c.entry);
  });
  entries.forEach((e, i) => {
    const c = CASES.find((k) => k.entry === e);
    if (c) caseIndex.set(i, c);
  });

  const res = await fetch("http://localhost:3000/api/normalize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries }),
  });
  if (!res.ok) {
    console.error(`run ${run}: HTTP ${res.status}`);
    process.exit(1);
  }
  const { entries: out } = (await res.json()) as { entries: { kind: string; title: string }[] };

  console.log(`\n=== run ${run} ===`);
  let pass = 0;
  for (const [i, c] of caseIndex) {
    const got = out[i]!;
    const kindOk = got.kind === c.expect.kind;
    const titleOk =
      c.expect.kind !== "book" ||
      c.expect.title === undefined ||
      (c.expect.title === null ? got.title.trim().length > 0 : norm(got.title) === norm(c.expect.title));
    const ok = kindOk && titleOk;
    if (ok) pass++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${c.note}`);
    if (!ok)
      console.log(
        `        entry: ${JSON.stringify(c.entry)}\n        got: [${got.kind}] ${JSON.stringify(got.title)} — want [${c.expect.kind}] ${JSON.stringify(c.expect.title ?? "(any)")}`,
      );
  }
  console.log(`  → ${pass}/${caseIndex.size}`);
  totalPass += pass;
  totalCases += caseIndex.size;
}
console.log(`\nTOTAL: ${totalPass}/${totalCases} (${runs} runs)`);
