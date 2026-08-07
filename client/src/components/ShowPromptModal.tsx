import { useEffect, useState } from "react";
import type { PromptPreview, RunRequest } from "@sb/shared";

export function ShowPromptModal({ body, onClose }: { body: RunRequest; onClose: () => void }) {
  const [data, setData] = useState<PromptPreview | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/run/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => (r.ok ? (r.json() as Promise<PromptPreview>) : Promise.reject(new Error(`Preview failed (${r.status})`))))
      .then((d) => alive && setData(d))
      .catch((e: unknown) => alive && setErr(e instanceof Error ? e.message : "Failed to load prompt"));
    return () => {
      alive = false;
    };
  }, [body]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>
            Assembled prompt
            {data && <span className="muted"> · {data.model} · effort {data.effort}</span>}
          </h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          {err && <div className="banner error">{err}</div>}
          {!data && !err && <p className="muted">Loading…</p>}
          {data && (
            <>
              <PromptBlock label="Stage 1 · system" text={data.stage1.system} />
              <PromptBlock label="Stage 1 · user" text={data.stage1.user} />
              <PromptBlock label="Stage 3 · system" text={data.stage3.system} />
              <PromptBlock label="Stage 3 · user (template)" text={data.stage3.userTemplate} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PromptBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="prompt-block">
      <div className="prompt-label">{label}</div>
      <pre className="prompt-pre">{text}</pre>
    </div>
  );
}
