import type { CSSProperties } from "react";
import type { Pace, ScoredCard } from "@sb/shared";
import type { FinalistControls } from "../lib/finalists";
import { BookDetail } from "./BookDetail";

interface Props {
  book: ScoredCard;
  pace: Pace;
  color: string;
  finalists: FinalistControls;
  onClose: () => void;
  /** false on shared read-only links — no Select button (there's no tray to select into). */
  interactive?: boolean;
}

/** Left rail: the full detail of the PINNED book (click a cover to pin it here). On phones it
 * renders as a bottom sheet, closable via the ✕. */
export function PreviewPanel({ book, pace, color, finalists, onClose, interactive = true }: Props) {
  return (
    <aside className="preview" style={{ "--cluster": color } as CSSProperties}>
      <button className="pv-close" onClick={onClose} aria-label="Close">
        ×
      </button>
      <BookDetail book={book} pace={pace} color={color} finalists={finalists} interactive={interactive} />
    </aside>
  );
}
