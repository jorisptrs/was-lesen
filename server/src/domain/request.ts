import { type Effort, type Member, type Pace, type PastRead, type RunRequest, HISTORY_CAP, mergeHistory } from "@sb/shared";
import { parseMembers } from "./members";

export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** What each UI preset buys. Named presets — never raw model strings from the client — keep a
 * public URL from requesting arbitrary expensive models. "best" uses high (not max): max needs
 * the passphrase and buys little for a monthly group decision. */
export const QUALITY_PRESETS: Record<string, { model: string; effort: Effort }> = {
  test: { model: "claude-haiku-4-5", effort: "low" },
  standard: { model: "claude-sonnet-5", effort: "high" },
  best: { model: "claude-fable-5", effort: "high" },
};

/** Resolve the run's model + effort: a valid `quality` preset wins; else the legacy raw
 * `effort` (model left to the server default); else the configured fallback effort. */
export function resolveQuality(body: RunRequest, fallbackEffort: Effort): { model?: string; effort: Effort } {
  const preset = body.quality ? QUALITY_PRESETS[body.quality] : undefined;
  if (preset) return preset;
  const effort = body.effort && EFFORTS.includes(body.effort) ? body.effort : fallbackEffort;
  return { effort };
}

/** Prefer structured `members` (e.g. a Tally import); fall back to parsing `membersText`. */
export function resolveMembers(body: RunRequest): Member[] {
  if (Array.isArray(body.members) && body.members.length > 0) return body.members;
  if (typeof body.membersText === "string") return parseMembers(body.membersText);
  return [];
}

/**
 * The run's full past-reads history: what the request carried, merged with the laptop's
 * persistent store. This is THE seam — `ResolvedRun.history` feeds the exclusion set and both
 * prompts, so merging here makes the store apply to generation, scoring, exclusions and
 * Show-Prompt without any of them knowing the store exists.
 */
export function resolveRunHistory(body: RunRequest, stored: PastRead[]): PastRead[] | undefined {
  const { history, dropped } = mergeHistory(resolveHistory(body), stored);
  if (dropped > 0) {
    console.warn(`[history] ${dropped} past read(s) over the ${HISTORY_CAP} cap — they will NOT be excluded`);
  }
  return history.length > 0 ? history : undefined;
}

/** Sanitize the past-reads history from the client (cap sizes; drop malformed entries). */
export function resolveHistory(body: RunRequest): PastRead[] | undefined {
  if (!Array.isArray(body.history)) return undefined;
  const reads = body.history
    .filter((h): h is PastRead => !!h && typeof h.title === "string" && h.title.trim().length > 0)
    .slice(0, 24)
    .map((h) => ({
      title: h.title.trim(),
      ...(typeof h.author === "string" && h.author.trim() ? { author: h.author.trim() } : {}),
      ...(typeof h.avgRating === "number" ? { avgRating: h.avgRating } : {}),
      notes: (Array.isArray(h.notes) ? h.notes : [])
        .filter((n) => n && typeof n.member === "string" && typeof n.note === "string" && n.note.trim())
        .slice(0, 16)
        .map((n) => ({ member: n.member, rating: typeof n.rating === "number" ? n.rating : null, note: n.note.slice(0, 300) })),
    }));
  return reads.length > 0 ? reads : undefined;
}

/** Default 180 pages / 2 weeks: the simple intake form doesn't ask about pace, so the fallback
 * is what most runs actually use (the organizer can still hand-edit it). */
export function normalizePace(pace: Pace | undefined): Pace {
  const pages = pace && pace.pages > 0 ? Math.round(pace.pages) : 180;
  const weeks = pace && pace.weeks > 0 ? Math.round(pace.weeks) : 2;
  return { pages, weeks };
}
