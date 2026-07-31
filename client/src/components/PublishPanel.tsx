import { useState } from "react";
import type { SavedRun } from "@sb/shared";
import { publishRun } from "../lib/api";

interface Props {
  getRun: () => SavedRun;
}

/** Organizer-only: make the current map THE one everyone sees at the main link. */
export function PublishPanel({ getRun }: Props) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const publish = async () => {
    setState("busy");
    setError(null);
    try {
      const r = await publishRun(getRun());
      setTarget(r.publishedTo ?? null);
      setState("done");
    } catch (e) {
      setState("idle");
      setError(e instanceof Error ? e.message : "Could not publish.");
    }
  };

  return (
    <div className="share">
      <button className="share-btn" onClick={() => setOpen((o) => !o)}>
        publish
      </button>
      {open && (
        <div className="share-pop">
          <p className="share-hint">
            Make this map the one everyone sees at the main link — it stays up until you publish
            another run.
          </p>
          {error && <p className="share-err">{error}</p>}
          {state === "done" ? (
            <p className="share-hint">
              ✓ Published — {target ? `live at ${target.replace(/^https?:\/\//, "")}` : "the main link now shows this map"}.
            </p>
          ) : (
            <button className="btn primary" disabled={state === "busy"} onClick={publish}>
              Publish this run
            </button>
          )}
        </div>
      )}
    </div>
  );
}
