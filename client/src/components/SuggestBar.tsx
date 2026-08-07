import { useState } from "react";
import type { PendingBook } from "@sb/shared";
import { Cover } from "./Cover";

interface Props {
  members: { name: string }[];
  /** Verified-but-unscored books waiting for the next scoring pass. */
  pending: PendingBook[];
  onAdd: (title: string, author: string, nominatedBy: string | null) => void;
  onRemove: (id: string) => void;
  onRescore: () => void;
  /** A catalog lookup is in flight. */
  checking: boolean;
  /** The scoring pass is running. */
  scoring: boolean;
  /** Books already on the map — the scoring pass covers those too. */
  mapSize: number;
  status: string | null;
}

/**
 * "Someone just named a book" — the human backstop for the whole pipeline. Lives in the MAP
 * CHROME next to the tray, not in the input drawer: the drawer auto-collapses the moment results
 * land, and this is a post-run control used with the map on screen.
 *
 * Enter adds a book: it's looked up in the catalog immediately (cheap, ~a second) and parked.
 * Nothing is scored until the button is pressed, and then EVERYTHING is — new books and old
 * together — because a fit only means something relative to the other books in the same call.
 *
 * The attribution dropdown defaults to nobody. Attributing a book to a member who merely said it
 * out loud is the same misattribution the provenance badge exists to prevent.
 */
export function SuggestBar({ members, pending, onAdd, onRemove, onRescore, checking, scoring, mapSize, status }: Props) {
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [who, setWho] = useState("");

  const submit = () => {
    if (!title.trim() || scoring) return;
    onAdd(title.trim(), author.trim(), who || null);
    setTitle("");
    setAuthor("");
  };

  return (
    <div className="suggestbar">
      {pending.length > 0 && (
        <div className="sb-pending">
          {pending.map((b) => (
            <span className="sb-chip" key={b.id} title={`${b.title}${b.author ? ` — ${b.author}` : ""}`}>
              <Cover title={b.title} author={b.author} coverUrl={b.coverUrl} verify={b.status} size={{ w: 18, h: 27 }} />
              <span className="sb-chip-title">{b.title}</span>
              <button onClick={() => onRemove(b.id)} disabled={scoring} aria-label={`Remove ${b.title}`}>
                ×
              </button>
            </span>
          ))}
          <button className="btn primary sb-score" onClick={onRescore} disabled={scoring}>
            {scoring ? "scoring…" : `Score ${pending.length} new + ${mapSize} on the map`}
          </button>
        </div>
      )}

      <div className="suggestbar-row">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="add a book"
          aria-label="Book title"
          disabled={scoring}
        />
        <input
          className="sb-author"
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="author"
          aria-label="Author (optional)"
          disabled={scoring}
        />
        <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Suggested by" disabled={scoring}>
          <option value="">no one</option>
          {members.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name}
            </option>
          ))}
        </select>
        <button className="linkbtn" onClick={submit} disabled={scoring || !title.trim()}>
          add
        </button>
        {(checking || scoring) && <span className="sb-busy" aria-label="working" />}
      </div>
      {status && <div className="suggestbar-status muted">{status}</div>}
    </div>
  );
}
