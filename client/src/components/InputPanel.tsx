import { useRef, useState } from "react";
import type { FocusEvent } from "react";
import type { Pace, PastRead, RunQuality } from "@sb/shared";
import { sessionsForPages } from "../lib/sessions";
import type { PaceStats, TallyMember } from "../lib/tallyCsv";
import { PaceGraph } from "./PaceGraph";

/** Named presets the server maps to model + effort (never raw model strings from the client). */
const QUALITIES: { value: RunQuality; label: string; hint: string }[] = [
  { value: "test", label: "test — cheapest", hint: "Haiku, no extended thinking · ~$0.25 per run · for trying things out" },
  { value: "standard", label: "standard — Sonnet", hint: "Sonnet 5 at high effort · ~$1 per run" },
  { value: "best", label: "best — Fable", hint: "Fable 5 at high effort · the strongest model · for the real monthly pick" },
];

interface Props {
  members: TallyMember[];
  setMembers: (m: TallyMember[]) => void;
  constraints: string;
  setConstraints: (v: string) => void;
  pace: Pace;
  setPace: (v: Pace) => void;
  paceStats: PaceStats | null;
  quality: RunQuality;
  setQuality: (v: RunQuality) => void;
  history: PastRead[];
  onClearHistory: () => void;
  running: boolean;
  onRun: () => void;
  onCancel: () => void;
  onShowPrompt: () => void;
  onSave: () => void;
  canSave: boolean;
  onLoadFile: (file: File) => void;
  onLoadCsv: (file: File) => void;
}

const emptyMember = (n: number): TallyMember => ({ name: `Member ${n}`, paragraph: "", loved: [], read: [], suggest: [] });

export function InputPanel(props: Props) {
  const { members, setMembers, constraints, setConstraints, pace, setPace, paceStats, quality, setQuality } = props;
  const fileRef = useRef<HTMLInputElement>(null);
  const csvRef = useRef<HTMLInputElement>(null);
  const [idx, setIdx] = useState(0);
  const [editing, setEditing] = useState(false);

  const cur = Math.min(idx, Math.max(0, members.length - 1));
  const member = members[cur];
  const last = members.length - 1;
  const sampleSessions = sessionsForPages(320, pace);

  const patch = (p: Partial<TallyMember>) => setMembers(members.map((m, j) => (j === cur ? { ...m, ...p } : m)));
  const lines = (arr: string[]) => arr.join("\n");
  const toLines = (v: string) => v.split("\n"); // keep blanks while typing; serialize filters them
  // Leave edit mode only when focus moves entirely outside the editor (not between its fields).
  const onEditBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setEditing(false);
  };
  const addMember = () => {
    setMembers([...members, emptyMember(members.length + 1)]);
    setIdx(members.length);
    setEditing(true);
  };
  const removeMember = () => {
    setMembers(members.filter((_, j) => j !== cur));
    setIdx((i) => Math.max(0, i - 1));
  };
  const go = (d: number) => setIdx((i) => Math.max(0, Math.min(last, i + d)));
  const clean = (arr: string[]) => arr.map((s) => s.trim()).filter(Boolean);
  // "Title — Author" → "Title (Author)". No "by" heuristic: normalize converts real "X by Y"
  // entries to "X — Y" at import, and titles can CONTAIN "by" ("Bird by Bird" ≠ "Bird (Bird)").
  const fmt = (s: string): string => {
    for (const sep of [" — ", " – ", " - "]) {
      const i = s.indexOf(sep);
      if (i > 0) return `${s.slice(0, i).trim()} (${s.slice(i + sep.length).trim()})`;
    }
    return s;
  };
  const listText = (arr: string[]) => clean(arr).map(fmt).join(" · ");

  return (
    <div className="input-form">
      <div className="panel-body">
        <div className="field-head">
          <span className="field-label">Members ({members.length})</span>
        </div>

        {members.length === 0 ? (
          <div className="deck-empty muted">
            No members yet. <button className="linkbtn" onClick={addMember}>Add one</button> or Load CSV.
          </div>
        ) : (
          <div className={`flashcard${member!.skip ? " skipped" : ""}`}>
            {editing ? (
              <div className="fc-edit" onBlur={onEditBlur}>
                <input className="fc-edit-name" value={member!.name} autoFocus onChange={(e) => patch({ name: e.target.value })} placeholder="Name" />
                <textarea className="fc-edit-para" value={member!.paragraph} onChange={(e) => patch({ paragraph: e.target.value })} rows={4} spellCheck={false} placeholder="What they want to read…" />
                <label className="fc-edit-list">
                  <span>liked</span>
                  <textarea value={lines(member!.loved)} onChange={(e) => patch({ loved: toLines(e.target.value) })} rows={2} spellCheck={false} placeholder="one book per line" />
                </label>
                <label className="fc-edit-list">
                  <span>suggestions</span>
                  <textarea value={lines(member!.suggest)} onChange={(e) => patch({ suggest: toLines(e.target.value) })} rows={2} spellCheck={false} />
                </label>
                <label className="fc-edit-list">
                  <span>exclusions</span>
                  <textarea value={lines(member!.read)} onChange={(e) => patch({ read: toLines(e.target.value) })} rows={2} spellCheck={false} />
                </label>
              </div>
            ) : (
              <>
                {/* Both edge zones always render so a click at the edge navigates (or is a no-op at
                    the ends) and never falls through to the card's edit handler. */}
                <button className={`fc-nav left${cur === 0 ? " off" : ""}`} onClick={() => go(-1)} aria-label="Previous member">
                  ‹
                </button>
                <button className={`fc-nav right${cur === last ? " off" : ""}`} onClick={() => go(1)} aria-label="Next member">
                  ›
                </button>
                <div className="fc-body" key={cur}>
                  <div className="fc-name">
                    {member!.name}
                    {member!.skip && <span className="fc-skipped-chip"> · skipped this round</span>}
                  </div>
                  {member!.paragraph && <div className="fc-sub">{member!.paragraph}</div>}
                  {clean(member!.loved).length > 0 && (
                    <div className="fc-list">
                      <span>liked</span>
                      <p>{listText(member!.loved)}</p>
                    </div>
                  )}
                  {clean(member!.suggest).length > 0 && (
                    <div className="fc-list">
                      <span>suggestions</span>
                      <p>{listText(member!.suggest)}</p>
                    </div>
                  )}
                  {clean(member!.read).length > 0 && (
                    <div className="fc-list">
                      <span>exclusions</span>
                      <p>{listText(member!.read)}</p>
                    </div>
                  )}
                </div>
              </>
            )}
            {/* Card actions in the bottom-right corner (edit/done as two separate buttons: a
                toggle would race the editor's blur-to-close). */}
            <span className="fc-links">
              {!editing && (
                <button
                  className="linkbtn"
                  onClick={() => patch({ skip: !member!.skip })}
                  title={member!.skip ? "Include them in the next pick again" : "They'll sit the next book out — leave their prefs out of the run"}
                >
                  {member!.skip ? "include" : "skip"}
                </button>
              )}
              {editing ? (
                <button className="linkbtn" onClick={() => setEditing(false)}>
                  done
                </button>
              ) : (
                <button className="linkbtn" onClick={() => setEditing(true)}>
                  edit
                </button>
              )}
            </span>
            <div className="fc-foot">
              <span className="deck-count">{cur + 1} / {members.length}</span>
              <span className="deck-spacer" />
              <button className="linkbtn" onClick={addMember} title="Add a member">
                +
              </button>
              <button className="linkbtn" onClick={removeMember} title="Remove this member">
                −
              </button>
            </div>
          </div>
        )}

        <label className="field">
          <span className="field-label">Constraints</span>
          <textarea
            value={constraints}
            onChange={(e) => setConstraints(e.target.value)}
            rows={3}
            spellCheck={false}
            placeholder="languages, formats, diversity of authors…"
          />
        </label>

        {props.history.length > 0 && (
          <div className="history-note">
            <span className="field-label">Past reads</span>{" "}
            {props.history
              .map((h) => `${h.title}${h.avgRating != null ? ` (${h.avgRating}/5${h.finished ? `, ${h.finished}` : ""})` : ""}`)
              .join(" · ")}{" "}
            <button className="linkbtn" onClick={props.onClearHistory} title="Forget the loaded feedback">
              clear
            </button>
          </div>
        )}

        <div className="settings">
          {paceStats && <PaceGraph stats={paceStats} />}
          <label className="pace">
            <span className="field-label">Pace</span>
            <input type="number" min={1} value={pace.pages} onChange={(e) => setPace({ ...pace, pages: Number(e.target.value) })} />
            <span>pages /</span>
            <input type="number" min={1} value={pace.weeks} onChange={(e) => setPace({ ...pace, weeks: Number(e.target.value) })} />
            <span>weeks</span>
          </label>
          <span className="hint">a 320-page book = {sampleSessions ?? "?"} sessions</span>

          <label className="effort" title={QUALITIES.find((q) => q.value === quality)?.hint}>
            <span className="field-label">Claude</span>
            <select value={quality} onChange={(e) => setQuality(e.target.value as RunQuality)}>
              {QUALITIES.map((q) => (
                <option key={q.value} value={q.value} title={q.hint}>
                  {q.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) props.onLoadFile(f);
            e.target.value = "";
          }}
        />
        <input
          ref={csvRef}
          type="file"
          accept="text/csv,.csv"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) props.onLoadCsv(f);
            e.target.value = "";
          }}
        />
        <div className="actions">
          {/* Quiet text links — Run is the only real button. */}
          <div className="quiet-actions">
            <button className="linkbtn" onClick={() => csvRef.current?.click()}>
              load csv
            </button>
            <button className="linkbtn" onClick={() => fileRef.current?.click()}>
              load run
            </button>
            <button className="linkbtn" onClick={props.onSave} disabled={!props.canSave}>
              save run
            </button>
            <button className="linkbtn" onClick={props.onShowPrompt}>
              show prompt
            </button>
          </div>
          {props.running ? (
            <button className="btn danger run" onClick={props.onCancel}>
              Cancel
            </button>
          ) : (
            <button
              className="btn primary run"
              onClick={props.onRun}
              disabled={members.every((m) => m.skip)}
              title={members.every((m) => m.skip) ? "Everyone is skipped — include at least one member" : undefined}
            >
              Run
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
