import type { ScoredCard } from "@sb/shared";

/** How many selections the tray holds — roomy enough for in-room inspection. */
export const TRAY_CAP = 10;

/** Passed down to the map + hover card so a cover can be added to / removed from the tray. */
export interface FinalistControls {
  isFinalist: (id: string) => boolean;
  toggle: (book: ScoredCard) => void;
  canAddMore: boolean;
}
