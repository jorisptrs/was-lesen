import { titleCase } from "./titleCase";
import type { TallyMember } from "./tallyCsv";

interface ResolvedEntry {
  matched: boolean;
  title: string;
  author: string;
}

const LISTS = ["loved", "read", "suggest"] as const;

// Entries are stored as "Title — Author" (normalize's output format) or bare titles.
const splitRef = (s: string): { title: string; author: string } => {
  const i = s.indexOf(" — ");
  return i > 0 ? { title: s.slice(0, i).trim(), author: s.slice(i + 3).trim() } : { title: s.trim(), author: "" };
};

/**
 * Canonicalize EVERY book the members mentioned (liked, suggestions, exclusions) against the
 * books API (`/api/resolve`, cache-first, $0 Claude) and rewrite them in place — so the cards
 * show "Title (Author)" for each, with a missing author filled from the catalog ("Sapiens" →
 * "Sapiens — Yuval Noah Harari"). Duplicate mentions resolve once. Best-effort; throws on
 * transport failure (caller ignores — the cleaned strings are fine).
 */
export async function resolveBookLists(members: TallyMember[]): Promise<number> {
  const slots: { member: TallyMember; list: (typeof LISTS)[number]; index: number; key: string }[] = [];
  const unique = new Map<string, { title: string; author: string }>();
  for (const member of members) {
    for (const list of LISTS) {
      member[list].forEach((s, index) => {
        if (!s.trim()) return;
        const ref = splitRef(s);
        const key = `${ref.title.toLowerCase()}|${ref.author.toLowerCase()}`;
        slots.push({ member, list, index, key });
        if (!unique.has(key)) unique.set(key, ref);
      });
    }
  }
  if (slots.length === 0) return 0;

  const keys = [...unique.keys()];
  const res = await fetch("/api/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries: keys.map((k) => unique.get(k)!) }),
  });
  if (!res.ok) throw new Error(`resolve failed (${res.status})`);
  const { entries } = (await res.json()) as { entries: ResolvedEntry[] };
  if (!Array.isArray(entries)) throw new Error("resolve returned no entries");

  const byKey = new Map(keys.slice(0, entries.length).map((k, i) => [k, entries[i]!]));
  let changed = 0;
  for (const slot of slots) {
    const r = byKey.get(slot.key);
    if (!r?.matched || !r.title) continue;
    const title = titleCase(r.title);
    const next = r.author ? `${title} — ${r.author}` : title;
    if (next !== slot.member[slot.list][slot.index]) {
      slot.member[slot.list][slot.index] = next;
      changed++;
    }
  }
  return changed;
}
