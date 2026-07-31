import type { Pace, ScoredCard } from "@sb/shared";
import { TRAY_CAP } from "../lib/finalists";
import { Cover } from "./Cover";

interface Props {
  tray: ScoredCard[];
  pace: Pace;
  onRemove: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
  onPresent: () => void;
}

/** The selections tray: ordered picks for the in-person vote — ‹ › set the Present order. */
export function Tray({ tray, onRemove, onMove, onPresent }: Props) {
  return (
    <div className="tray">
      <div className="tray-label">
        Selections{" "}
        <span className="muted">
          {tray.length}/{TRAY_CAP}
        </span>
      </div>
      <div className="tray-items">
        {tray.map((b, i) => (
          <div className="tray-item" key={b.id}>
            <span className="tray-pos">{i + 1}</span>
            <Cover title={b.title} author={b.author} coverUrl={b.coverUrl} verify={b.status} size={{ w: 34, h: 51 }} />
            <div className="tray-item-meta">
              <div className="tray-item-title" title={b.title}>
                {b.title}
              </div>
              <div className="tray-item-sub">{b.author}</div>
            </div>
            <span className="tray-move">
              <button onClick={() => onMove(b.id, -1)} disabled={i === 0} aria-label="Rank higher" title="Rank higher">
                ‹
              </button>
              <button
                onClick={() => onMove(b.id, 1)}
                disabled={i === tray.length - 1}
                aria-label="Rank lower"
                title="Rank lower"
              >
                ›
              </button>
            </span>
            <button className="tray-remove" onClick={() => onRemove(b.id)} aria-label="Remove">
              ×
            </button>
          </div>
        ))}
      </div>
      <button className="btn primary tray-present" disabled={tray.length === 0} onClick={onPresent}>
        Present
      </button>
    </div>
  );
}
