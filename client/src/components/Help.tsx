import { useState } from "react";

/** The "?" in the top-right: a three-line super-summary of how the tool nominates, scores,
 * and maps — enough for a first-time group member on the projector, no more. */
export function Help() {
  const [open, setOpen] = useState(false);
  return (
    <div className="help" onMouseLeave={() => setOpen(false)}>
      <button className="help-btn" onClick={() => setOpen((o) => !o)} aria-label="How this works" title="How this works">
        ?
      </button>
      {open && (
        <div className="help-pop">
          <p>
            <b>Nominate</b> — Claude proposes candidates from everyone's tastes, alongside member
            suggestions and liked books. Every title is checked against real book catalogs;
            anything unconfirmed is flagged, never invented. Books the group has already read
            together, or that anyone marked as read, are left out.
          </p>
          <p>
            <b>Score</b> — each book gets a 1–10 fit per member, grounded in that member's own
            words, plus a discussability score. The strongest ~25 make the map, every member
            served by at least two picks; group rules (languages, bans) filter violators out.
          </p>
          <p>
            <b>Map</b> — books are embedded by meaning and placed so similar books sit near each
            other; the topic groups come from hierarchical clustering on those embeddings (group
            count chosen automatically), then get named. The number on each cover is that book's
            rank among the picks (1 first): 0.8 × average fit + 0.2 × discussability, with a slight discount for long books.
          </p>
          <p className="help-src">
            Open source —{" "}
            <a href="https://github.com/jorisptrs/was-lesen" target="_blank" rel="noreferrer noopener">
              github.com/jorisptrs/was-lesen
            </a>
          </p>
        </div>
      )}
    </div>
  );
}
