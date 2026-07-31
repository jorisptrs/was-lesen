import { useEffect, useState } from "react";
import type { Pace, ScoredCard } from "@sb/shared";
import { COMPLEXITY, EXPEDITION, MODE, provenanceBadge, summaryParas, UNVERIFIED } from "../lib/labels";
import { sessionsForPages } from "../lib/sessions";
import { Cover } from "./Cover";
import { Tag } from "./Tag";

interface Props {
  tray: ScoredCard[];
  pace: Pace;
  onClose: () => void;
}

/** Full-screen advocacy view: one finalist per screen, ‹/› or arrow keys to move, Esc to close. */
export function Present({ tray, pace, onClose }: Props) {
  const [i, setI] = useState(0);
  const idx = Math.max(0, Math.min(i, tray.length - 1));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") setI((v) => Math.min(tray.length - 1, v + 1));
      else if (e.key === "ArrowLeft") setI((v) => Math.max(0, v - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tray.length, onClose]);

  const book = tray[idx];
  if (!book) return null;
  const sessions = sessionsForPages(book.pageCount, pace);

  return (
    <div className="present">
      <button className="present-close" onClick={onClose} aria-label="Close">
        ×
      </button>

      <div className="present-card">
        <Cover title={book.title} author={book.author} coverUrl={book.coverUrl} verify={book.status} size={{ w: 244, h: 366 }} />
        <div className="present-info">
          <h2 className="present-title">{book.title}</h2>
          <div className="present-author">
            {book.author}
            {book.year ? ` · ${book.year}` : ""}
          </div>

          <div className="present-price">
            {book.pageCount ? `${book.pageCount} pages` : "length unknown"}
            {sessions != null && (
              <>
                {" · "}
                <b>
                  {sessions} session{sessions === 1 ? "" : "s"}
                </b>{" "}
                at {pace.pages}p / {pace.weeks}wk
              </>
            )}
          </div>

          <div className="present-tags">
            <Tag badge={COMPLEXITY[book.complexity]} />
            <Tag badge={MODE[book.mode]} />
            {book.expedition && <Tag badge={EXPEDITION} className="exp" />}
            {book.status === "unverified" && <Tag badge={UNVERIFIED} className="warn" />}
            <Tag badge={provenanceBadge(book)} />
          </div>

          {summaryParas(book.summary).map((p, i) => (
            <p key={i} className="present-summary">
              {p}
            </p>
          ))}
          {book.rationale && (
            <p className="present-line">
              <b>Why:</b> {book.rationale}
            </p>
          )}

          <div className="present-fits">
            {book.perMember.map((p) => (
              <span key={p.member} className="present-fit">
                {p.member} <b>{p.fit}</b>
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="present-nav">
        <button onClick={() => setI((v) => Math.max(0, v - 1))} disabled={idx === 0} aria-label="Previous">
          ‹
        </button>
        <span className="present-count">
          {idx + 1} / {tray.length}
        </span>
        <button onClick={() => setI((v) => Math.min(tray.length - 1, v + 1))} disabled={idx === tray.length - 1} aria-label="Next">
          ›
        </button>
      </div>
    </div>
  );
}
