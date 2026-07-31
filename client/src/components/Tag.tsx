import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Badge } from "../lib/labels";

interface Props {
  badge: Badge;
  className?: string;
  style?: CSSProperties;
}

/** A badge whose explanation pops up INSTANTLY on hover (no dwell delay); tap toggles it on
 * touch. Inert inside the hover card. The popover is centered under the badge, then nudged
 * back inside the viewport (edge badges in the narrow rail would otherwise clip). */
export function Tag({ badge, className, style }: Props) {
  const [open, setOpen] = useState(false);
  const [shift, setShift] = useState(0);
  const popRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    if (!open) {
      setShift(0);
      return;
    }
    const r = popRef.current?.getBoundingClientRect();
    if (!r) return;
    const pad = 8;
    if (r.left < pad) setShift(pad - r.left);
    else if (r.right > window.innerWidth - pad) setShift(window.innerWidth - pad - r.right);
  }, [open]);

  return (
    <span
      className={`hc-tag ${className ?? ""}${open ? " open" : ""}`}
      style={style}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onClick={(e) => {
        e.stopPropagation();
        setOpen((o) => !o);
      }}
      role="button"
      tabIndex={0}
    >
      {badge.label}
      {open && (
        <span ref={popRef} className="tag-pop" style={{ transform: `translateX(calc(-50% + ${shift}px))` }}>
          {badge.info}
        </span>
      )}
    </span>
  );
}
