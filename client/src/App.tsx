import { useEffect, useMemo, useRef, useState } from "react";
import type { Pace, PastRead, RunQuality, RunRequest, ScoredCard } from "@sb/shared";
import { BookList } from "./components/BookList";
import { CoverMap } from "./components/CoverMap";
import { Help } from "./components/Help";
import { InputPanel } from "./components/InputPanel";
import { Present } from "./components/Present";
import { PreviewPanel } from "./components/PreviewPanel";
import { PublishPanel } from "./components/PublishPanel";
import { ShowPromptModal } from "./components/ShowPromptModal";
import { Tray } from "./components/Tray";
import { UnlockPanel } from "./components/UnlockPanel";
import { useRunStream } from "./hooks/useRunStream";
import { TRAY_CAP, type FinalistControls } from "./lib/finalists";
import { clusterColorFor } from "./lib/palette";
import { buildSavedRun, downloadRun, parseSavedRun } from "./lib/savedRun";
import { checkUnlocked, fetchCurrent, savePassphrase } from "./lib/api";
import { normalizeMembers } from "./lib/normalize";
import { resolveBookLists } from "./lib/resolve";
import {
  paceStatsFrom,
  type PaceStats,
  type TallyMember,
  buildMembersText,
  detectCsvKind,
  mergePastReads,
  parseFeedbackCsv,
  parseMembersText,
  stripSkippedConstraints,
  tallyCsvToMembersText,
} from "./lib/tallyCsv";
import type { RunState } from "./state";

export default function App() {
  const { state, start, cancel, loadRun } = useRunStream();
  // Members are the primary editable state (card deck); the run/save/preview use the derived text.
  const [members, setMembers] = useState<TallyMember[]>([]);
  const [constraints, setConstraints] = useState("");
  const [pace, setPace] = useState<Pace>({ pages: 160, weeks: 2 });
  const [paceStats, setPaceStats] = useState<PaceStats | null>(null);
  const [quality, setQuality] = useState<RunQuality>("test");
  const [promptOpen, setPromptOpen] = useState(false);
  const [tray, setTray] = useState<ScoredCard[]>([]);
  const [present, setPresent] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [importWarning, setImportWarning] = useState<string | null>(null);
  // Past group reads + feedback (from the feedback-form CSV) — excluded from candidates and
  // used to calibrate Stage-3 fits. Survives runs; cleared explicitly or by loading a run.
  const [history, setHistory] = useState<PastRead[]>([]);
  // Banners float over the map and would block covers beneath them — any banner dismisses on
  // click. Reset per run so new warnings always show.
  const [hiddenBanners, setHiddenBanners] = useState<Set<string>>(new Set());
  const dismissBanner = (text: string) => setHiddenBanners((s) => new Set(s).add(text));
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const clearFocus = () => setPinnedId(null);

  // One link for everyone: the main page shows the latest PUBLISHED run read-only; the
  // organizer unlocks (passphrase) to run/publish. null = still probing the gate on boot.
  const [unlocked, setUnlocked] = useState<boolean | null>(null);
  const viewerMode = unlocked !== true;
  const [publishedLoaded, setPublishedLoaded] = useState(false);

  // The run sees only the members who'll be there for the next book; skipped members' tastes,
  // lists, and named constraint lines stay out of the selection entirely.
  const membersText = useMemo(() => buildMembersText(members), [members]);
  const activeMembers = useMemo(() => members.filter((m) => !m.skip), [members]);
  const skippedNames = useMemo(() => members.filter((m) => m.skip).map((m) => m.name), [members]);
  // A skipped member's reading budget leaves the pace stats too — their slow fortnight must
  // not cap a round they're sitting out.
  const activePaceStats = useMemo(() => {
    if (!paceStats) return null;
    const skipped = new Set(skippedNames.map((n) => n.toLowerCase()));
    return paceStatsFrom(paceStats.perMember.filter((p) => !skipped.has(p.name.toLowerCase())));
  }, [paceStats, skippedNames]);
  // Follow the suggestion automatically only while the pace still IS the suggestion — a
  // hand-edited pace is never overridden.
  const autoPaceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!activePaceStats || autoPaceRef.current === null) return;
    if (pace.pages === autoPaceRef.current && activePaceStats.avg !== pace.pages) {
      autoPaceRef.current = activePaceStats.avg;
      setPace((p) => ({ ...p, pages: activePaceStats.avg }));
    }
  }, [activePaceStats, pace.pages]);
  const body = useMemo<RunRequest>(
    () => ({
      membersText: buildMembersText(activeMembers),
      constraints: stripSkippedConstraints(constraints, skippedNames),
      pace,
      quality,
      ...(history.length ? { history } : {}),
    }),
    [activeMembers, skippedNames, constraints, pace, quality, history],
  );
  const running = state.status === "running";

  const scored = state.scored;
  const colorOf = useMemo(
    () => new Map((scored?.clusters ?? []).map((cl, i) => [cl.label, clusterColorFor(i)])),
    [scored],
  );
  const byId = useMemo(() => new Map((scored?.books ?? []).map((b) => [b.id, b])), [scored]);
  const activeBook = (pinnedId && byId.get(pinnedId)) || null;
  const activeColor = activeBook ? colorOf.get(activeBook.clusterLabel) ?? "#888888" : "#888888";
  const onPin = (id: string) => setPinnedId((p) => (p === id ? null : id));

  // Boot: probe the gate (200 = organizer or gate off) and load the published run for
  // everyone (ref-guarded: StrictMode mounts effects twice in dev).
  const bootRef = useRef(false);
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    checkUnlocked()
      .then((ok) => {
        if (!ok) savePassphrase(""); // a stale stored passphrase must not look unlocked
        setUnlocked(ok);
      })
      .catch(() => setUnlocked(false));
    fetchCurrent()
      .then((run) => {
        if (run) {
          setPace(run.input.pace);
          // The boot-loaded published map must NOT collapse the drawer — the organizer's
          // session starts at the input panel; only a fresh run/file-load hands over the screen.
          autoCollapsedRef.current = true;
          loadRun(run.members, run.scored);
        }
      })
      .catch(() => {
        // no published run (or unreachable) — the idle stage says so
      })
      .finally(() => setPublishedLoaded(true));
  }, [loadRun]);

  // Collapse the input drawer once when results arrive, to hand the screen to the map (the group
  // browses on a projector). Guarded per run so a manual re-open isn't fought.
  const autoCollapsedRef = useRef(false);
  useEffect(() => {
    if (scored && !autoCollapsedRef.current) {
      autoCollapsedRef.current = true;
      setDrawerOpen(false);
    }
  }, [scored]);

  const finalists: FinalistControls = {
    isFinalist: (id) => tray.some((b) => b.id === id),
    toggle: (book) =>
      setTray((t) => (t.some((b) => b.id === book.id) ? t.filter((b) => b.id !== book.id) : t.length >= TRAY_CAP ? t : [...t, book])),
    canAddMore: tray.length < TRAY_CAP,
  };
  const removeFinalist = (id: string) => setTray((t) => t.filter((b) => b.id !== id));
  const moveFinalist = (id: string, dir: -1 | 1) =>
    setTray((t) => {
      const i = t.findIndex((b) => b.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= t.length) return t;
      const next = [...t];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  const runNow = () => {
    setTray([]);
    setPresent(false);
    setLoadError(null);
    setImportWarning(null);
    setHiddenBanners(new Set());
    clearFocus();
    autoCollapsedRef.current = false;
    start(body);
  };
  // The current run as a SavedRun — used by Save and by publish identically.
  const currentRun = () =>
    buildSavedRun({
      input: {
        membersText, // the FULL roster — skips are recorded separately so nothing is lost
        constraints,
        pace,
        quality,
        ...(history.length ? { history } : {}),
        ...(skippedNames.length ? { skipped: skippedNames } : {}),
      },
      members: state.members,
      scored: state.scored!,
    });
  const onSave = () => {
    if (state.scored) downloadRun(currentRun());
  };
  const onLoadFile = async (file: File) => {
    try {
      const saved = parseSavedRun(await file.text());
      const skipped = new Set((saved.input.skipped ?? []).map((n) => n.toLowerCase()));
      setMembers(
        parseMembersText(saved.input.membersText).map((m) =>
          skipped.has(m.name.toLowerCase()) ? { ...m, skip: true } : m,
        ),
      );
      setPaceStats(null);
      setConstraints(saved.input.constraints);
      setPace(saved.input.pace);
      setQuality(saved.input.quality ?? "test"); // pre-quality saves fall back to the cheap preset
      setHistory(saved.input.history ?? []);
      setTray([]);
      setPresent(false);
      setLoadError(null);
      clearFocus();
      autoCollapsedRef.current = false;
      loadRun(saved.members, saved.scored);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load that file.");
    }
  };
  const onLoadCsv = async (file: File) => {
    try {
      const text = await file.text();
      // The same "load csv" link takes both forms — the intake and the post-read feedback CSV.
      if (detectCsvKind(text) === "feedback") {
        setHistory((prev) => mergePastReads(prev, parseFeedbackCsv(text)));
        setLoadError(null);
        return;
      }
      const imp = tallyCsvToMembersText(text);
      setMembers(imp.members);
      setConstraints(imp.constraints);
      setPaceStats(imp.paceStats);
      if (imp.paceHint) {
        setPace({ pages: imp.paceHint, weeks: 2 });
        autoPaceRef.current = imp.paceHint;
      }
      setLoadError(null);
      setImportWarning(null);

      // Stage 0: AI-fix typos/formats in the book lists; corrections land in the editable cards
      // so a human can veto them before Run. Prose rules found in a list ("no Russian classics")
      // move into Constraints; paragraphs and constraint lines get pleasantries/meta stripped.
      // Quiet on success (the cards updating IS the feedback) — only a failure banners.
      try {
        const constraintLines = imp.constraints.split("\n").filter(Boolean);
        const { rules, cleanedConstraints } = await normalizeMembers(imp.members, constraintLines);
        const base = cleanedConstraints ?? constraintLines;
        const combined = [...base.filter(Boolean), ...rules.map((r) => `${r.member}: ${r.text}`)];
        if (combined.join("\n") !== imp.constraints) setConstraints(combined.join("\n"));
        // Then canonicalize every mentioned book against the books catalog so the cards show
        // "Title (Author)" throughout. Best-effort — a miss just keeps the cleaned string.
        await resolveBookLists(imp.members).catch(() => {});
        setMembers([...imp.members]); // members were mutated in place — new array reference to re-render
      } catch {
        setMembers([...imp.members]);
        setImportWarning("Title cleanup unavailable — using the lists as typed.");
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not read that CSV.");
    }
  };

  return (
    <div
      className={`workspace ${drawerOpen ? "drawer-open" : "drawer-closed"} ${activeBook ? "preview-open" : "preview-closed"}`}
    >
      <div className="brandbar">
        <StatusBar state={state} />
      </div>
      <Help />
      {unlocked === true && scored && <PublishPanel getRun={currentRun} />}
      {viewerMode && scored && (
        <div className="pace-pill" title="Reading pace — only changes your own sessions estimate">
          <span className="muted">pace</span>
          <input type="number" min={10} step={10} value={pace.pages} onChange={(e) => setPace({ ...pace, pages: Number(e.target.value) || pace.pages })} />
          <span>p /</span>
          <input type="number" min={1} value={pace.weeks} onChange={(e) => setPace({ ...pace, weeks: Number(e.target.value) || pace.weeks })} />
          <span>wks</span>
        </div>
      )}
      {unlocked === false && <UnlockPanel onUnlocked={() => setUnlocked(true)} />}

      {activeBook && (
        <PreviewPanel
          book={activeBook}
          pace={pace}
          color={activeColor}
          finalists={finalists}
          onClose={clearFocus}
        />
      )}

      {scored ? (
        <CoverMap
          scored={scored}
          finalists={finalists}
          pinnedId={pinnedId}
          onPin={onPin}
          colorOf={colorOf}
          pace={pace}
        />
      ) : (
        <div className="map-stage">
          {state.books.length > 0 ? (
            <div className="stage-scroll">
              <BookList books={state.books} pace={pace} />
            </div>
          ) : (
            <div className="stage-idle muted">
              {viewerMode
                ? publishedLoaded
                  ? "No book map published yet."
                  : "Loading the group's picks…"
                : running
                  ? "Working…"
                  : "Load a CSV or paste members in the panel, then Run."}
            </div>
          )}
        </div>
      )}

      {!viewerMode && (
      <aside className="drawer">
        <button
          className="drawer-toggle"
          onClick={() => setDrawerOpen((o) => !o)}
          aria-expanded={drawerOpen}
          aria-label={drawerOpen ? "Collapse input" : "Open input"}
          title={drawerOpen ? "Collapse input" : "Open input"}
        >
          {drawerOpen ? "›" : "‹"}
        </button>
        {drawerOpen && (
          <div className="drawer-body">
            <InputPanel
              members={members}
              setMembers={setMembers}
              constraints={constraints}
              setConstraints={setConstraints}
              pace={pace}
              setPace={setPace}
              paceStats={activePaceStats}
              quality={quality}
              setQuality={setQuality}
              history={history}
              onClearHistory={() => setHistory([])}
              running={running}
              onRun={runNow}
              onCancel={cancel}
              onShowPrompt={() => setPromptOpen(true)}
              onSave={onSave}
              canSave={!!scored}
              onLoadFile={onLoadFile}
              onLoadCsv={onLoadCsv}
            />
          </div>
        )}
      </aside>
      )}

      <div className="banners">
        {[
          ...(state.error ? [{ kind: "error", text: state.error }] : []),
          ...(loadError ? [{ kind: "error", text: loadError }] : []),
          ...(importWarning ? [{ kind: "warn", text: importWarning }] : []),
          ...(scored && scored.selection.unservableMembers.length > 0
            ? [{ kind: "warn", text: `No good pick found for: ${scored.selection.unservableMembers.join(", ")}.` }]
            : []),
          ...state.warnings.map((w) => ({ kind: "warn", text: w })),
        ]
          .filter((b) => !hiddenBanners.has(b.text))
          .map((b) => (
            <div key={b.text} className={`banner ${b.kind}`} onClick={() => dismissBanner(b.text)} title="Click to dismiss" role="button">
              {b.text}
            </div>
          ))}
      </div>

      {scored && (
        <Tray tray={tray} pace={pace} onRemove={removeFinalist} onMove={moveFinalist} onPresent={() => setPresent(true)} />
      )}

      {present && tray.length > 0 && <Present tray={tray} pace={pace} onClose={() => setPresent(false)} />}
      {!viewerMode && promptOpen && <ShowPromptModal body={body} onClose={() => setPromptOpen(false)} />}
    </div>
  );
}

function StatusBar({ state }: { state: RunState }) {
  // Idle and done show nothing — once the map is up it should speak for itself.
  if (state.status !== "running" && state.status !== "error") return null;
  return (
    <div className={`statusbar ${state.status}`}>
      {state.status === "running" && (
        <span>
          <span className="spinner" /> {runningPhase(state)}
        </span>
      )}
      {state.status === "error" && <span>error</span>}
    </div>
  );
}

function runningPhase(state: RunState): string {
  const v = state.verify;
  if (!v) return "generating candidates…";
  if (v.resolved < v.total) return `verifying ${v.resolved}/${v.total}${v.dropped ? ` · ${v.dropped} dropped` : ""}`;
  if (!state.scored) return "scoring…";
  return "finalizing…";
}
