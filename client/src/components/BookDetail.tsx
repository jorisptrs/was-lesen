import type { Pace, ScoredCard } from "@sb/shared";
import { TRAY_CAP, type FinalistControls } from "../lib/finalists";
import { AVG_FIT_INFO, COMPLEXITY, DISCUSSABILITY_INFO, EXPEDITION, MODE, provenanceBadge, summaryParas, UNVERIFIED } from "../lib/labels";
import { sessionsForPages } from "../lib/sessions";
import { Cover } from "./Cover";
import { Tag } from "./Tag";

interface Props {
  book: ScoredCard;
  pace: Pace;
  color: string;
  finalists: FinalistControls;
  /** The left rail is interactive (Add button); the on-hover card is display-only (pin to act). */
  interactive?: boolean;
}

/** The full book detail, ordered as the group reads it: what is it (identity, badges, summary) →
 * who is it for (fit bars, scores) → why it's here → act. Shared by the left preview rail
 * (`PreviewPanel`) and the on-map hover card (`HoverCard`, which shows a compact summary). */
export function BookDetail({ book, pace, color, finalists, interactive = true }: Props) {
  const sessions = sessionsForPages(book.pageCount, pace);
  const provenance = provenanceBadge(book);
  const complexity = COMPLEXITY[book.complexity];
  const mode = MODE[book.mode];
  // Hover card stays a glance: first paragraph only. The pinned rail gets the full summary.
  const paras = summaryParas(book.summary);
  const shownParas = interactive ? paras : paras.slice(0, 1);

  return (
    <>
      <div className="pv-cover">
        <Cover title={book.title} author={book.author} coverUrl={book.coverUrl} verify={book.status} size={{ w: 132, h: 198 }} accent={color} />
      </div>

      <h2 className="pv-title">{book.title}</h2>
      {(book.author || book.year) && (
        <div className="pv-author">{[book.author, book.year].filter(Boolean).join(" · ")}</div>
      )}

      <div className="hc-facts">
        {book.pageCount ? `${book.pageCount}p` : "? pages"}
        {sessions != null && ` · ${sessions} session${sessions === 1 ? "" : "s"} at pace`}
      </div>
      <div className="hc-tags">
        <Tag badge={complexity} />
        <Tag badge={mode} />
        {book.expedition && <Tag badge={EXPEDITION} className="exp" />}
        {book.status === "unverified" && <Tag badge={UNVERIFIED} className="warn" />}
        <Tag badge={provenance} className="prov" style={{ color }} />
      </div>

      {shownParas.map((p, i) => (
        <p key={i} className="hc-summary">
          {p}
        </p>
      ))}

      <div className="hc-fits">
        {book.perMember.map((p) => (
          <div key={p.member} className="hc-fit">
            <span className="hc-fit-name">{p.member}</span>
            <span className="hc-fit-bar">
              <span style={{ width: `${Math.max(0, Math.min(100, p.fit * 10))}%`, background: color }} />
            </span>
            <span className="hc-fit-num">{p.fit}</span>
          </div>
        ))}
      </div>

      <div className="hc-foot">
        <span title={AVG_FIT_INFO}>
          avg fit <b>{book.avgFit}</b>
        </span>
        <span title={DISCUSSABILITY_INFO}>
          discussability <b>{book.discussability}</b>
        </span>
        {book.pulledInFor && <span className="hc-pull">pulled in for {book.pulledInFor}</span>}
      </div>

      {book.rationale && (
        <p className="hc-line">
          <b>Why:</b> {book.rationale}
        </p>
      )}

      {interactive && (
        <button
          className={`hc-add ${finalists.isFinalist(book.id) ? "on" : ""}`}
          onClick={() => finalists.toggle(book)}
          disabled={!finalists.isFinalist(book.id) && !finalists.canAddMore}
        >
          {finalists.isFinalist(book.id)
            ? "✓ Selected — remove"
            : finalists.canAddMore
              ? "Select"
              : `Selections full (${TRAY_CAP})`}
        </button>
      )}
    </>
  );
}
