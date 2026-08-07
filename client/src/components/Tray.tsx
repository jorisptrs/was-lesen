import type { Pace, ScoredCard } from "@sb/shared";
import { TRAY_CAP } from "../lib/finalists";
import { Cover } from "./Cover";

interface Props {
  tray: ScoredCard[];
  pace: Pace;
  /** Each book's rank across the whole map — the tray shows the same number the map does. */
  rankOf: Map<string, number>;
  onRemove: (id: string) => void;
  onPresent: () => void;
  onFinalMap: () => void;
  finalMap: boolean;
}

/**
 * The selections tray. Books show the rank they earned on the MAP, not a shortlist position —
 * so there is nothing to hand-order and the ‹ › controls are gone; the tray, the map and the
 * final map all say the same number about the same book.
 */
export function Tray({ tray, rankOf, onRemove, onPresent, onFinalMap, finalMap }: Props) {
  return (
    <div className="tray">
      <div className="tray-label">
        Selections{" "}
        <span className="muted">
          {tray.length}/{TRAY_CAP}
        </span>
      </div>
      <div className="tray-items">
        {tray.map((b) => (
          <div className="tray-item" key={b.id}>
            <span className="tray-pos" title="Rank on the map">
              {rankOf.get(b.id) ?? "–"}
            </span>
            <Cover title={b.title} author={b.author} coverUrl={b.coverUrl} verify={b.status} size={{ w: 34, h: 51 }} />
            <div className="tray-item-meta">
              <div className="tray-item-title" title={b.title}>
                {b.title}
              </div>
              <div className="tray-item-sub">{b.author}</div>
            </div>
            <button className="tray-remove" onClick={() => onRemove(b.id)} aria-label="Remove">

              ×
            </button>
          </div>
        ))}
      </div>
      <div className="tray-actions">
        {/* Only offered once there's something to show — an always-present disabled link is
            just noise next to an empty tray. */}
        {tray.length > 0 && (
          <button
            className="linkbtn"
            onClick={onFinalMap}
            title={finalMap ? "Back to the full map" : "Show only the selections, ranked in this order"}
          >
            {finalMap ? "full map" : "final map"}
          </button>
        )}
        <button className="btn primary tray-present" disabled={tray.length === 0} onClick={onPresent}>
          Present
        </button>
      </div>
    </div>
  );
}
