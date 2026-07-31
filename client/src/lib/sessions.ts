import type { Pace } from "@sb/shared";

/**
 * Reading "sessions" a book takes at a given pace: ceil(pages / pages-per-period).
 * Returns null when the page count is unknown or the pace is invalid. Computed on the
 * client — the model is never trusted with this arithmetic.
 */
export function sessionsForPages(pages: number | null, pace: Pace): number | null {
  if (pages == null || pace.pages <= 0) return null;
  return Math.ceil(pages / pace.pages);
}
