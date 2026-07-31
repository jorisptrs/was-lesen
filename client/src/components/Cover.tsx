import { useRef, useState } from "react";
import type { CSSProperties } from "react";
import { hashHue } from "../lib/placeholder";

interface CoverProps {
  title: string;
  author: string;
  coverUrl: string | null;
  verify: "pending" | "verified" | "unverified" | "dropped";
  size?: { w: number; h: number };
  /** Cluster color, drawn as a bottom strip so color-coding reads per cover. */
  accent?: string;
}

/** A book cover: the Open Library image, or a deterministic colored placeholder. The "verify"
 * badge on a cover-less / unverified book is the deliberate hallucination smell test. */
export function Cover({ title, author, coverUrl, verify, size, accent }: CoverProps) {
  const [imgFailed, setImgFailed] = useState(false);
  // Open Library's cover CDN throttles bursts (a 25-cover map from one IP): retry a failed
  // load once after a pause instead of flipping permanently to the placeholder.
  const [nonce, setNonce] = useState(0);
  const retried = useRef(false);
  const onImgError = () => {
    if (!retried.current) {
      retried.current = true;
      setTimeout(() => setNonce((n) => n + 1), 2500);
    } else {
      setImgFailed(true);
    }
  };
  const hasCover = !!coverUrl && !imgFailed;
  const pending = verify === "pending";
  const showVerify = !pending && (!hasCover || verify === "unverified");

  const style: CSSProperties = {};
  if (size) {
    style.width = size.w;
    style.height = size.h;
  }
  if (!hasCover) style.background = `hsl(${hashHue(title)} 42% 82%)`;
  if (accent) style.borderBottom = `3px solid ${accent}`;

  return (
    <div className="cover" style={style}>
      {hasCover ? (
        // draggable=false: native image-drag would hijack pointermove and kill map panning
        <img key={nonce} src={nonce ? `${coverUrl}?r=${nonce}` : coverUrl ?? ""} alt="" draggable={false} onError={onImgError} />
      ) : (
        <div className="cover-ph">
          <span className="ph-title">{title}</span>
          {author && <span className="ph-author">{author}</span>}
        </div>
      )}
      {pending && <span className="cover-spinner" aria-label="verifying" />}
      {showVerify && <span className="verify-badge">verify</span>}
    </div>
  );
}
