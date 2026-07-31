import type { Pace } from "@sb/shared";
import { sessionsForPages } from "../lib/sessions";
import type { BookView } from "../state";
import { Cover } from "./Cover";

/** Verify-phase view: a grid of books as covers resolve. Superseded by ScoredView once scored. */
export function BookList({ books, pace }: { books: BookView[]; pace: Pace }) {
  if (books.length === 0) return null;
  const visible = books.filter((b) => b.verify !== "dropped");
  const droppedCount = books.length - visible.length;

  return (
    <section className="books">
      <div className="books-grid">
        {visible.map((b) => {
          const sessions = sessionsForPages(b.pageCount, pace);
          return (
            <div key={b.id} className={`book ${b.verify}`}>
              <Cover title={b.title} author={b.author} coverUrl={b.coverUrl} verify={b.verify} />
              <div className="book-meta">
                <div className="b-title" title={b.title}>
                  {b.title}
                </div>
                {b.author && <div className="b-author">{b.author}</div>}
                <div className="b-facts">
                  {b.year ?? "—"} · {b.pageCount ? `${b.pageCount}p` : "?p"}
                  {sessions != null && ` · ${sessions} session${sessions === 1 ? "" : "s"}`}
                </div>
                {/* Color carries the origin (green = suggested, teal = liked, blue = Claude). */}
                <span className={`badge ${b.provenance}`}>
                  {b.provenance === "claude_own_pick" ? "Claude" : b.nominatedBy}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      {droppedCount > 0 && (
        <p className="dropped-note">{droppedCount} dropped — not found in Open Library (likely hallucinated).</p>
      )}
    </section>
  );
}
