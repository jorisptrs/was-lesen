import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import type { Pace, ScoredCard } from "@sb/shared";
import { rankByQuality } from "../lib/finalMap";
import type { FinalistControls } from "../lib/finalists";
import { type MapLayout, layoutMap } from "../lib/mapLayout";
import type { ScoredState } from "../state";
import { Cover } from "./Cover";
import { HoverCard } from "./HoverCard";

interface Props {
  scored: ScoredState;
  finalists: FinalistControls;
  pinnedId: string | null;
  onPin: (id: string) => void;
  colorOf: Map<string, string>;
  pace: Pace;
  /** Ranks computed over a LARGER set than what's rendered (the final map shows the shortlist
   * but keeps each book's rank across the whole map). */
  rankOverride?: Map<string, number>;
  /** Total the ranks are drawn from, for the legend ("of 18"). */
  rankTotal?: number;
  /** Drop the cluster names. On the final map a "cluster" is one or two covers, so its label
   * sits right on top of them — and a ranked shortlist doesn't need topic names anyway. */
  hideLabels?: boolean;
}

interface View {
  scale: number;
  tx: number;
  ty: number;
}

const SCALE_MIN = 0.25;
const SCALE_MAX = 3;
const DRAG_THRESHOLD = 4; // px of movement before a press counts as a pan (not a click)

/**
 * The cover map: each topic cluster is a packed blob of covers (see lib/mapLayout), blobs
 * positioned by embedding centroids. A movable canvas — drag to pan, wheel to zoom — with the fit
 * transform computed once per layout so covers keep a stable size on resize/collapse. Hover a cover
 * for its details (floating card); click to pin it into the left rail.
 */
export function CoverMap({ scored, finalists, pinnedId, onPin, colorOf, pace, rankOverride, rankTotal, hideLabels }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ scale: 1, tx: 0, ty: 0 });
  const [hovered, setHovered] = useState<{ book: ScoredCard; rect: DOMRect } | null>(null);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const byId = useMemo(() => new Map(scored.books.map((b) => [b.id, b])), [scored.books]);
  // Bowling-style rank: 1 = best overall pick, by the selection's own quality blend. The final
  // map passes the WHOLE map's ranks in, so a shortlisted book keeps the number it earned there.
  const rankOf = useMemo(() => rankOverride ?? rankByQuality(scored.books), [scored.books, rankOverride]);
  // Hovering a cluster LABEL dims every other cluster's covers; hovering a cover lights its label.
  const [hoverCluster, setHoverCluster] = useState<string | null>(null);

  // A label needs pointer events for that hover link, which means it also SWALLOWS clicks meant
  // for the covers it floats over — those books simply could not be pinned (found by driving a
  // suggestion whose new cover happened to land under one). Forward the click to the cover
  // underneath instead of eating it.
  const pinThrough = (e: ReactMouseEvent) => {
    const cover = document
      .elementsFromPoint(e.clientX, e.clientY)
      .find((el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains("map-cover"));
    cover?.click();
  };

  const layout = useMemo(() => {
    const clusters = scored.clusters.map((cl) => ({
      label: cl.label,
      color: colorOf.get(cl.label) ?? "#888888",
      centroid: cl.centroid,
      books: cl.bookIds
        .filter((id) => byId.has(id))
        .map((id) => ({ id, weight: byId.get(id)!.avgFit, pos: byId.get(id)!.pos })),
    }));
    return layoutMap(clusters);
  }, [scored.clusters, byId, colorOf]);

  // Rank badges default to the top-left corner but hop to the nearest corner a cluster title
  // doesn't cross (labels paint above covers, and a number under a title is unreadable).
  const badgeCorner = useMemo(() => {
    const corner = new Map<string, string>();
    const B = 15; // badge box incl. margin, world px
    const rects = layout.clusters.map((cl) => {
      const w = cl.label.length * 7.6 + 22; // same estimate the label relaxation uses
      const bottom = cl.cy - cl.r * 0.72;
      return { x1: cl.cx - w / 2, y1: bottom - 24, x2: cl.cx + w / 2, y2: bottom };
    });
    const covered = (x: number, y: number) => rects.some((r) => x + B > r.x1 && x < r.x2 && y + B > r.y1 && y < r.y2);
    for (const cl of layout.clusters) {
      for (const lb of cl.books) {
        const cands: [string, number, number][] = [
          ["tl", lb.x - lb.w / 2 + 2, lb.y - lb.h / 2 + 2],
          ["tr", lb.x + lb.w / 2 - B - 2, lb.y - lb.h / 2 + 2],
          ["bl", lb.x - lb.w / 2 + 2, lb.y + lb.h / 2 - B - 2],
          ["br", lb.x + lb.w / 2 - B - 2, lb.y + lb.h / 2 - B - 2],
        ];
        corner.set(lb.id, (cands.find(([, x, y]) => !covered(x, y)) ?? cands[0]!)[0]);
      }
    }
    return corner;
  }, [layout]);

  const fitView = useCallback((): View => {
    const pad = 40;
    if (!(layout.width > 0 && box.w > 0)) return { scale: 1, tx: 0, ty: 0 };
    const raw = Math.min((box.w - pad * 2) / layout.width, (box.h - pad * 2) / layout.height);
    const scale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, raw));
    return { scale, tx: (box.w - layout.width * scale) / 2, ty: (box.h - layout.height * scale) / 2 };
  }, [layout, box]);

  // Fit ONCE per new layout (keyed on layout identity) — NOT on resize/collapse.
  const fittedRef = useRef<MapLayout | null>(null);
  useLayoutEffect(() => {
    if (layout.width > 0 && box.w > 0 && fittedRef.current !== layout) {
      fittedRef.current = layout;
      setView(fitView());
    }
  }, [layout, box, fitView]);

  // Zoom toward the cursor. Native non-passive listener so preventDefault actually stops the page.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      setView((v) => {
        const scale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, v.scale * Math.exp(-e.deltaY * 0.0015)));
        const k = scale / v.scale;
        return { scale, tx: sx - (sx - v.tx) * k, ty: sy - (sy - v.ty) * k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Drag to pan. Track movement so a press that doesn't move still registers as a cover click.
  const drag = useRef<{ x: number; y: number; moved: boolean; captured: boolean; pointerId: number } | null>(null);
  const movedRef = useRef(false);
  // Touch: all active pointers; two of them make a pinch (midpoint + distance drive the same
  // anchor math as wheel zoom). A touch tap must pin, not open the mouse hover card.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; mx: number; my: number } | null>(null);
  const lastTouch = useRef(false);

  const endDrag = (e?: ReactPointerEvent) => {
    const d = drag.current;
    if (d?.captured && e) e.currentTarget.releasePointerCapture?.(d.pointerId);
    drag.current = null;
    setTimeout(() => {
      movedRef.current = false;
    }, 0);
  };
  const onPointerDown = (e: ReactPointerEvent) => {
    lastTouch.current = e.pointerType === "touch";
    // A primary pointer starts a NEW sequence — flush ghosts whose up/cancel never reached us
    // (iOS system-gesture steals, tab switches). One stale entry would otherwise turn every
    // future tap into a phantom pinch against a frozen point, permanently breaking the map.
    if (e.isPrimary) pointers.current.clear();
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // A 3rd finger during a pinch must not seed a drag or reset the click suppression.
    if (pinch.current) return;
    if (pointers.current.size === 2) {
      // Second finger down: a pinch replaces any drag and never counts as a click.
      drag.current = null;
      movedRef.current = true;
      setHovered(null);
      const [a, b] = [...pointers.current.values()];
      const rect = e.currentTarget.getBoundingClientRect();
      pinch.current = {
        dist: Math.hypot(a!.x - b!.x, a!.y - b!.y),
        mx: (a!.x + b!.x) / 2 - rect.left,
        my: (a!.y + b!.y) / 2 - rect.top,
      };
      try {
        for (const pid of pointers.current.keys()) e.currentTarget.setPointerCapture?.(pid);
      } catch {
        // a pointer vanished between down and capture — the pinch still tracks bubbled events
      }
      return;
    }
    if (e.button !== 0) return; // primary button only
    // Do NOT capture here: a captured pointer retargets the `click` to the stage, so a cover's
    // onClick never fires (no pin). Capture only once a real drag starts (in onPointerMove).
    drag.current = { x: e.clientX, y: e.clientY, moved: false, captured: false, pointerId: e.pointerId };
    movedRef.current = false;
    setHovered(null);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    // Mouse movement un-sticks hover after a touch (touchscreen laptops: tap, then mouse).
    if (e.pointerType === "mouse") lastTouch.current = false;
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const rect = e.currentTarget.getBoundingClientRect();
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      const mx = (a!.x + b!.x) / 2 - rect.left;
      const my = (a!.y + b!.y) / 2 - rect.top;
      const p = pinch.current;
      setView((v) => {
        const scale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, v.scale * (dist / Math.max(1, p.dist))));
        const k = scale / v.scale;
        // pan by the midpoint's travel, then zoom anchored at the new midpoint
        const tx = v.tx + (mx - p.mx);
        const ty = v.ty + (my - p.my);
        return { scale, tx: mx - (mx - tx) * k, ty: my - (my - ty) * k };
      });
      pinch.current = { dist, mx, my };
      return;
    }
    const d = drag.current;
    if (!d) return;
    // If the button was released off-canvas (its pointerup never reached us), end the drag on
    // re-entry instead of resuming from a stale anchor — that stale delta is the "snap" bug.
    if (e.buttons === 0) {
      endDrag(e);
      return;
    }
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_THRESHOLD) return;
    if (!d.captured) {
      e.currentTarget.setPointerCapture?.(d.pointerId); // keep panning smooth off-canvas
      d.captured = true;
    }
    d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    movedRef.current = true;
    setView((v) => ({ ...v, tx: v.tx + dx, ty: v.ty + dy }));
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pinch.current) {
      if (pointers.current.size >= 2) {
        // A 3rd finger lifted — rebase the pinch on the surviving pair (no zoom snap).
        const [a, b] = [...pointers.current.values()];
        const rect = e.currentTarget.getBoundingClientRect();
        pinch.current = {
          dist: Math.hypot(a!.x - b!.x, a!.y - b!.y),
          mx: (a!.x + b!.x) / 2 - rect.left,
          my: (a!.y + b!.y) / 2 - rect.top,
        };
      } else {
        pinch.current = null;
        const rest = [...pointers.current.entries()][0];
        // One finger stays down — hand off to a pan (moved, so lifting it is never a click).
        if (rest) drag.current = { x: rest[1].x, y: rest[1].y, moved: true, captured: true, pointerId: rest[0] };
      }
      return;
    }
    endDrag(e);
  };
  const onPointerCancel = (e: ReactPointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    endDrag(e);
  };

  const activeId = pinnedId ?? hovered?.book.id ?? null;

  return (
    <div
      className="map-stage"
      ref={stageRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onDoubleClick={() => setView(fitView())}
    >
      <div
        className="map-world"
        style={{ width: layout.width, height: layout.height, transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}
      >
        {layout.clusters.map((cl) => (
          <div key={cl.label} className="map-cluster">
            {cl.books.map((lb) => {
              const b = byId.get(lb.id)!;
              const fin = finalists.isFinalist(b.id);
              const active = activeId === b.id;
              const dim = hoverCluster !== null && cl.label !== hoverCluster;
              return (
                <div
                  key={b.id}
                  className={`map-cover${fin ? " fin" : ""}${active ? " active" : ""}${dim ? " dim" : ""}`}
                  style={{ left: lb.x - lb.w / 2, top: lb.y - lb.h / 2, width: lb.w, height: lb.h }}
                  onMouseEnter={(e) => {
                    // Touch fires synthetic mouseenter on tap — the tap pins instead (mobile
                    // shows the pinned sheet, not the hover card).
                    if (!drag.current && !pinch.current && !lastTouch.current)
                      setHovered({ book: b, rect: e.currentTarget.getBoundingClientRect() });
                  }}
                  onMouseLeave={() => setHovered(null)}
                  onClick={() => {
                    if (!movedRef.current) onPin(b.id);
                  }}
                  title={b.title}
                >
                  <Cover title={b.title} author={b.author} coverUrl={b.coverUrl} verify={b.status} size={{ w: lb.w, h: lb.h }} accent={cl.color} />
                  <span
                    className={`rank-badge ${badgeCorner.get(b.id) ?? "tl"}`}
                    title={`#${rankOf.get(b.id)} of ${rankTotal ?? scored.books.length} overall (fit + discussability, slight length discount)`}
                  >
                    {rankOf.get(b.id)}
                  </span>
                  {fin && <span className="fin-check">✓</span>}
                </div>
              );
            })}
            {!hideLabels && (
              <div
                className={`map-label${hovered?.book.clusterLabel === cl.label || hoverCluster === cl.label ? " hot" : ""}`}
                style={{ left: cl.cx, top: cl.cy - cl.r * 0.72, color: cl.color }}
                onMouseEnter={() => setHoverCluster(cl.label)}
                onMouseLeave={() => setHoverCluster(null)}
                onClick={pinThrough}
              >
                {cl.label}
              </div>
            )}
          </div>
        ))}
      </div>

      {hovered && (
        <HoverCard
          book={hovered.book}
          rect={hovered.rect}
          pace={pace}
          color={colorOf.get(hovered.book.clusterLabel) ?? "#888888"}
          finalists={finalists}
        />
      )}

      <button className="map-fit" onClick={() => setView(fitView())} title="Fit to view" aria-label="Fit to view">
        ⛶
      </button>
      <div className="rank-legend" aria-hidden="true">
        <span className="rank-legend-badge">1</span>
        {rankTotal && rankTotal > scored.books.length ? ` = best of all ${rankTotal}` : " = best match"}
      </div>
    </div>
  );
}
