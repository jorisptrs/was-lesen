import { useState } from "react";
import type { PastReadRow } from "@sb/shared";
import { Cover } from "./Cover";

interface Props {
  rows: PastReadRow[];
  onAdd: (row: Partial<PastReadRow>) => void;
  onDelete: (title: string) => void;
  busy: boolean;
  error: string | null;
}

/**
 * The group's reading history: what it has read together, how it landed, and one note per book.
 * Every run excludes these and calibrates Stage-3 fits against them, so it earns a panel rather
 * than living only inside an imported CSV. Collapsed by default — it grows for years and the
 * drawer is for the next book, not the last twenty.
 */
export function PastReadsPanel({ rows, onAdd, onDelete, busy, error }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ title: "", author: "", rating: "", note: "" });

  const submit = () => {
    const title = draft.title.trim();
    if (!title) return;
    onAdd({
      title,
      author: draft.author.trim(),
      rating: draft.rating.trim() ? Number(draft.rating) : null,
      note: draft.note.trim(),
    });
    setDraft({ title: "", author: "", rating: "", note: "" });
  };

  return (
    <div className="past-reads">
      {/* No export of its own: "save run" is THE export and already carries the past reads
          (they ride in the run's history). The raw CSV lives at
          ~/.cache/satisfying-books/past-reads.csv for hand edits. */}
      <div className="sec-head">
        <button className="linkbtn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className="field-label">Past reads</span> {rows.length}
        </button>
      </div>

      {open && (
        <>
          <ul className="past-reads-list">
            {rows.map((r) => (
              <li key={r.title}>
                <Cover title={r.title} author={r.author ?? ""} coverUrl={r.coverUrl ?? null} verify="verified" size={{ w: 26, h: 39 }} />
                <span className="pr-title">
                  {r.title}
                  {r.author ? ` (${r.author})` : ""}
                </span>
                {r.rating != null && <span className="pr-rating">{r.rating}/5</span>}
                <button
                  className="linkbtn pr-del"
                  onClick={() => onDelete(r.title)}
                  disabled={busy}
                  title="Forget this book"
                  aria-label={`Remove ${r.title}`}
                >
                  ×
                </button>
                {r.note && <div className="pr-note muted">{r.note}</div>}
              </li>
            ))}
            {rows.length === 0 && <li className="muted">Nothing yet — load a feedback CSV, or add one below.</li>}
          </ul>

          <div className="past-reads-add">
            <input
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              placeholder="title"
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
            <input
              value={draft.author}
              onChange={(e) => setDraft({ ...draft, author: e.target.value })}
              placeholder="author"
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
            <input
              className="pr-rating-input"
              value={draft.rating}
              onChange={(e) => setDraft({ ...draft, rating: e.target.value })}
              placeholder="1–5"
              inputMode="decimal"
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
            <input
              className="pr-note-input"
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              placeholder="what the group made of it"
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
            <button className="linkbtn" onClick={submit} disabled={busy || !draft.title.trim()}>
              add
            </button>
          </div>
          {error && <div className="pr-error muted">{error}</div>}
        </>
      )}
    </div>
  );
}
