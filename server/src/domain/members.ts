import type { Member } from "@sb/shared";
import { parseBookList } from "./bookref";

// Interim manual-input convention (the Tally import will produce Member[] directly):
//
//   Alice: slow literary novels about place and memory; translated fiction
//     loved: Housekeeping — Marilynne Robinson; The Rings of Saturn by W.G. Sebald
//     read: Ulysses
//     suggest: The Blue Flower — Penelope Fitzgerald
//
//   Ben: sci-fi that takes ideas seriously
//     nothing over 400 pages
//
// - Blocks are separated by blank lines; each block is one member.
// - The first line is `Name: paragraph…` (name ≤ 40 chars, no colon in the name).
// - Subsequent `loved:` / `read:` / `suggest:` lines populate the book lists.
// - Any other subsequent line continues the paragraph.
// - A block with no `Name:` first line is auto-named `Member N` and treated as paragraph.

type ListField = "loved" | "alreadyRead" | "suggestions";

function classifyListKey(rawKey: string): ListField | null {
  const k = rawKey.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (["loved", "love", "loves", "favorite", "favorites", "favourites"].includes(k)) return "loved";
  if (["read", "alreadyread", "haveread", "dontredo", "excluded", "exclude"].includes(k)) return "alreadyRead";
  if (["suggest", "suggestion", "suggestions", "suggesting", "nominate", "nomination", "nominations"].includes(k))
    return "suggestions";
  return null;
}

const NAME_LINE = /^([^:]{1,40}):\s*(.*)$/;
const SUBLINE = /^([A-Za-z][\w '-]{0,20}):\s*(.*)$/;

export function parseMembers(text: string): Member[] {
  const blocks = text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  return blocks.map((block, idx) => {
    const lines = block
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const member: Member = {
      name: `Member ${idx + 1}`,
      paragraph: "",
      suggestions: [],
      alreadyRead: [],
      loved: [],
    };
    const paragraphParts: string[] = [];

    let start = 0;
    const nameMatch = lines[0]!.match(NAME_LINE);
    if (nameMatch && classifyListKey(nameMatch[1]!) === null) {
      member.name = nameMatch[1]!.trim();
      if (nameMatch[2]!.trim()) paragraphParts.push(nameMatch[2]!.trim());
      start = 1;
    }

    for (let i = start; i < lines.length; i++) {
      const line = lines[i]!;
      const m = line.match(SUBLINE);
      const field = m ? classifyListKey(m[1]!) : null;
      if (m && field) {
        member[field].push(...parseBookList(m[2]!));
      } else {
        paragraphParts.push(line);
      }
    }

    member.paragraph = paragraphParts.join(" ").replace(/\s+/g, " ").trim();
    return member;
  });
}
