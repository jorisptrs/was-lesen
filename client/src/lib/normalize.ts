import type { NormalizeEvent, NormalizeResult } from "@sb/shared";
import { postSseStream } from "./sse";
import { titleCase } from "./titleCase";
import type { TallyMember } from "./tallyCsv";

export interface NormalizeSummary {
  books: number; // entries kept as book references (cleaned or unchanged)
  fixed: number; // of those, how many the cleanup actually changed
  dropped: number; // non-book notes removed
  /** Actionable prose rules found inside the lists ("no Russian classics") — the caller routes
   * these into the Constraints box instead of losing them. */
  rules: { member: string; text: string }[];
  /** The anything-else constraint lines, cleaned of pleasantries — null if cleaning failed. */
  cleanedConstraints: string[] | null;
}

/** Items cleaned so far, out of the total — for the import status line during the ~70s call. */
export type NormalizeProgress = (done: number, total: number) => void;

interface Outcome {
  result: NormalizeResult | null;
  error: string | null;
}

/**
 * Stage 0: send the raw intake to `/api/normalize` (one Claude call, streamed) and apply the
 * cleanups in place — canonical `Title — Author` for book references, drop non-book prose,
 * surface prose RULES for the Constraints box, and strip pleasantries/meta from member
 * paragraphs and constraint lines ("thank you for organising!" is not taste signal).
 * Existence is NOT decided here (the books API does that at run time), so anything title-shaped
 * is kept as a book. Throws on any failure; the caller falls back to raw strings.
 */
export async function normalizeMembers(
  members: TallyMember[],
  constraintLines: string[],
  onProgress?: NormalizeProgress,
): Promise<NormalizeSummary> {
  const lists: (keyof Pick<TallyMember, "loved" | "read" | "suggest">)[] = ["loved", "read", "suggest"];
  const slots: { member: TallyMember; list: (typeof lists)[number]; index: number }[] = [];
  for (const member of members) {
    for (const list of lists) {
      member[list].forEach((_, index) => slots.push({ member, list, index }));
    }
  }
  const summary: NormalizeSummary = { books: 0, fixed: 0, dropped: 0, rules: [], cleanedConstraints: null };
  if (slots.length === 0 && members.length === 0 && constraintLines.length === 0) return summary;

  const body = {
    entries: slots.map((s) => s.member[s.list][s.index]),
    paragraphs: members.map((m) => m.paragraph),
    rules: constraintLines,
  };

  // One attempt = one open stream. A resolved stream that never delivered `normalize_result` is
  // a FAILURE — under SSE the response is `ok` the moment the headers land, long before any
  // work happens, so the old `res.ok` retry test could never fire.
  const attempt = async (): Promise<Outcome> => {
    // A holder object, not two `let`s: TypeScript doesn't track assignments made inside a
    // callback, so plain locals would narrow to `null` at the return.
    const got: Outcome = { result: null, error: null };
    await postSseStream<NormalizeEvent>("/api/normalize", body, (e) => {
      if (e.type === "normalize_progress") onProgress?.(e.done, e.total);
      else if (e.type === "normalize_result") got.result = e.result;
      else if (e.type === "normalize_error") got.error = e.message;
    });
    return got;
  };

  // One retry: a transient failure here silently ships raw hedge-strings into the run
  // (observed live: "off top of my head probably Sapiens" became a map card).
  let outcome = await attempt().catch((e: unknown) => ({
    result: null,
    error: e instanceof Error ? e.message : "normalize failed",
  }));
  if (!outcome.result) {
    await new Promise((r) => setTimeout(r, 1500));
    outcome = await attempt();
  }
  if (!outcome.result) throw new Error(outcome.error ?? "normalize returned no result");
  const { entries, paragraphs, rules } = outcome.result;
  if (!Array.isArray(entries)) throw new Error("normalize returned no entries");

  // The server reconciles by position and may cap very large groups; apply what came back and
  // leave any untouched entries as the member typed them.
  const removals: { member: TallyMember; list: (typeof lists)[number]; index: number }[] = [];
  entries.slice(0, slots.length).forEach((e, i) => {
    const slot = slots[i]!;
    if (e.kind === "rule") {
      // A preference/ban typed into a list ("as well as anything from Russian classics") — keep
      // it as a group-visible constraint under the member's name, never silently delete it.
      removals.push(slot);
      summary.rules.push({ member: slot.member.name, text: slot.member[slot.list][slot.index]! });
      return;
    }
    if (e.kind === "not_a_book" || !e.title) {
      removals.push(slot);
      summary.dropped++;
      return;
    }
    summary.books++;
    // Keep the author only when it was actually in the member's text; an inferred author is often
    // wrong and would block the books-API match, so we let a title-only search resolve it.
    const title = titleCase(e.title);
    const cleaned = e.authorFromText && e.author ? `${title} — ${e.author}` : title;
    if (cleaned !== slot.member[slot.list][slot.index]) summary.fixed++;
    slot.member[slot.list][slot.index] = cleaned;
  });
  // Delete back-to-front so earlier indices stay valid.
  for (const r of removals.reverse()) r.member[r.list].splice(r.index, 1);

  // Cleaned paragraphs: apply in order; never let the cleanup DELETE a real paragraph (an empty
  // result for a non-trivial original is treated as a miss, not a removal).
  if (Array.isArray(paragraphs)) {
    paragraphs.slice(0, members.length).forEach((p, i) => {
      const cleaned = p.trim();
      const original = members[i]!.paragraph.trim();
      if (cleaned && cleaned !== original) members[i]!.paragraph = cleaned;
      else if (!cleaned && original.length < 40) members[i]!.paragraph = "";
    });
  }

  if (Array.isArray(rules)) {
    summary.cleanedConstraints = rules.map((r) => r.trim());
  }
  return summary;
}
