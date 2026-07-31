/**
 * The selection blend: how much a book's average group fit vs its discussion spark counts,
 * minus a slight length discount favouring shorter reads. Single source of truth — server
 * selection and the map's rank badges must agree on what "quality" means.
 *
 * Length term: −0.1 per step of (pages − 200)/60, capped at −1 total — i.e. a 320-page book
 * gives up 0.2, a 500-page one 0.5, and 800+ pages the full point. Unknown page counts are
 * never penalized (null pages are first-class, not a demerit).
 */
export function qualityOf(avgFit: number, discussability: number, pageCount?: number | null): number {
  const lengthPenalty = pageCount ? 0.1 * Math.min(10, Math.max(0, (pageCount - 200) / 60)) : 0;
  return 0.8 * avgFit + 0.2 * discussability - lengthPenalty;
}
