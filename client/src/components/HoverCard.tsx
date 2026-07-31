import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Pace, ScoredCard } from "@sb/shared";
import type { FinalistControls } from "../lib/finalists";
import { BookDetail } from "./BookDetail";

interface Props {
  book: ScoredCard;
  rect: DOMRect;
  pace: Pace;
  color: string;
  finalists: FinalistControls;
}

const CARD_W = 300;
const MARGIN = 8;

/** Floating detail card shown next to a cover on hover. Positioned AFTER measuring its real
 * rendered height (content varies per book), clamped fully inside the viewport — right of the
 * cover, flipping left near the right edge. */
export function HoverCard({ book, rect, pace, color, finalists }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth || CARD_W;
    const h = el.offsetHeight;
    let left = rect.right + 12;
    if (left + w > window.innerWidth - MARGIN) left = rect.left - w - 12;
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - w - MARGIN));
    let top = rect.top - 8;
    top = Math.max(MARGIN, Math.min(top, window.innerHeight - h - MARGIN));
    setPos({ left, top });
  }, [book, rect]);

  return (
    <div
      ref={ref}
      className="hovercard"
      // First paint is invisible at a safe spot; the effect measures, clamps, and reveals.
      style={{ left: pos?.left ?? MARGIN, top: pos?.top ?? MARGIN, width: CARD_W, visibility: pos ? "visible" : "hidden", "--cluster": color } as CSSProperties}
    >
      <BookDetail book={book} pace={pace} color={color} finalists={finalists} interactive={false} />
    </div>
  );
}
