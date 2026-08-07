import { useEffect, useMemo, useRef, useState } from "react";
import {
  type Pace,
  type PastRead,
  type PastReadRow,
  type RunQuality,
  type RunRequest,
  type ScoredCard,
  mergeHistory,
  pastReadsToHistory,
  scoredMemberNames,
  titleKey,
} from "@sb/shared";
import { BookList } from "./components/BookList";
import { CoverMap } from "./components/CoverMap";
import { Help } from "./components/Help";
import { InputPanel } from "./components/InputPanel";
import { Present } from "./components/Present";
import { PreviewPanel } from "./components/PreviewPanel";
import { PublishPanel } from "./components/PublishPanel";
import { ShowPromptModal } from "./components/ShowPromptModal";
import { SuggestBar } from "./components/SuggestBar";
import { Tray } from "./components/Tray";
import { useRunStream } from "./hooks/useRunStream";
import { usePendingBooks } from "./hooks/usePendingBooks";
import { TRAY_CAP, type FinalistControls } from "./lib/finalists";
import { clusterColorFor } from "./lib/palette";
import { buildSavedRun, downloadRun, parseSavedRun } from "./lib/savedRun";
import { fetchCanRun, fetchCurrent } from "./lib/api";
import { deletePastRead, fetchPastReads, savePastReads } from "./lib/pastReads";
import { rankByQuality, trayMapState } from "./lib/finalMap";
import { normalizeMembers } from "./lib/normalize";
import { resolveBookLists } from "./lib/resolve";
import {
  paceStatsFrom,
  type PaceStats,
  type TallyMember,
  buildMembersText,
  isFeedbackCsv,
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
  // 180 p/2wk: the simple intake form doesn't ask about pace, so this default is what most runs
  // use. A CSV that DOES carry pace answers overrides it (paceHint).
  const [pace, setPace] = useState<Pace>({ pages: 180, weeks: 2 });
  const [paceStats, setPaceStats] = useState<PaceStats | null>(null);
  const [quality, setQuality] = useState<RunQuality>("test");
  const [promptOpen, setPromptOpen] = useState(false);
  const [tray, setTray] = useState<ScoredCard[]>([]);
  const [present, setPresent] = useState(false);
  const [finalMap, setFinalMap] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [importWarning, setImportWarning] = useState<string | null>(null);
  // Stage-0 cleanup takes ~70s on a real CSV — the status line is the only sign it's alive.
  const [importStatus, setImportStatus] = useState<ImportStatus | null>(null);
  const [importElapsed, setImportElapsed] = useState(0);
  // Past group reads: the persistent store on this laptop (the panel edits it; every run
  // excludes and calibrates against it) plus whatever a loaded SavedRun brought with it. The
  // server merges the store in again on its side, so a request that can't reach it still works.
  const [pastReads, setPastReads] = useState<PastReadRow[]>([]);
  const [loadedHistory, setLoadedHistory] = useState<PastRead[]>([]);
  const [pastReadsBusy, setPastReadsBusy] = useState(false);
  const [pastReadsError, setPastReadsError] = useState<string | null>(null);
  const history = useMemo(
    () => mergeHistory(loadedHistory, pastReadsToHistory(pastReads)).history,
    [loadedHistory, pastReads],
  );
  // Banners float over the map and would block covers beneath them — any banner dismisses on
  // click. Reset per run so new warnings always show.
  const [hiddenBanners, setHiddenBanners] = useState<Set<string>>(new Set());
  const dismissBanner = (text: string) => setHiddenBanners((s) => new Set(s).add(text));
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const clearFocus = () => setPinnedId(null);

  // One link for everyone, and no passphrase: which app you get is decided by what the SERVER
  // can do. The organizer's laptop has a `claude` login and serves the run routes; a host has
  // neither, so it IS the read-only viewer — those endpoints don't exist there at all.
  // `null` = still probing on boot.
  const [canRun, setCanRun] = useState<boolean | null>(null);
  const viewerMode = canRun !== true;
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
    if (pace.pages === autoPaceRef.current && activePaceStats.median !== pace.pages) {
      autoPaceRef.current = activePaceStats.median;
      setPace((p) => ({ ...p, pages: activePaceStats.median }));
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
  // The map on screen and the roster in the panel can be from different runs — most often the
  // boot-loaded PUBLISHED map, which stays up until you Run. Nothing said so, so the drawer
  // showed your members while every book's fit bars showed someone else's. Say it plainly.
  const mapMembers = useMemo(() => scoredMemberNames(scored?.books ?? []), [scored]);
  const rosterMismatch = useMemo(() => {
    if (viewerMode || mapMembers.length === 0 || activeMembers.length === 0) return null;
    const key = (ns: string[]) => [...ns].map((n) => n.trim().toLowerCase()).sort().join("|");
    return key(mapMembers) === key(activeMembers.map((m) => m.name)) ? null : mapMembers;
  }, [viewerMode, mapMembers, activeMembers]);
  // ONE rank per book, computed across the whole map, used by the map, the tray and the final
  // map alike. A trayed book the map somehow lacks is included so it still gets a number.
  const rankOf = useMemo(() => {
    const known = new Set((scored?.books ?? []).map((b) => b.id));
    return rankByQuality([...(scored?.books ?? []), ...tray.filter((b) => !known.has(b.id))]);
  }, [scored, tray]);
  // Show the shortlist best-first. With ranks coming off the map there is nothing to hand-order,
  // so the tray, the final map and Present all follow the same one.
  const traySorted = useMemo(
    () => [...tray].sort((a, z) => (rankOf.get(a.id) ?? Infinity) - (rankOf.get(z.id) ?? Infinity)),
    [tray, rankOf],
  );
  // The tray alone — no re-scoring, everything trayed was scored when it landed there.
  const finalMapState = useMemo(() => trayMapState(traySorted, scored?.clusters ?? []), [traySorted, scored]);
  // Leaving the final map when the tray empties keeps the button and the view in agreement.
  useEffect(() => {
    if (finalMap && tray.length === 0) setFinalMap(false);
  }, [finalMap, tray.length]);
  const activeBook = (pinnedId && byId.get(pinnedId)) || null;
  const activeColor = activeBook ? colorOf.get(activeBook.clusterLabel) ?? "#888888" : "#888888";
  const onPin = (id: string) => setPinnedId((p) => (p === id ? null : id));

  // Boot: probe the gate (200 = organizer or gate off) and load the published run for
  // everyone (ref-guarded: StrictMode mounts effects twice in dev).
  const bootRef = useRef(false);
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    fetchCanRun()
      .then((ok) => {
        setCanRun(ok);
        // The store only exists on a machine that runs the pipeline — a host doesn't serve it.
        if (ok) fetchPastReads().then(setPastReads).catch(() => setPastReadsError("Past reads unavailable."));
      })
      .catch(() => setCanRun(false));
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

  // The Stage-0 count is coarse by nature (the agent often writes its whole file in one turn),
  // so the elapsed seconds carry the "still alive" signal through the long silent stretch.
  // Keyed on the phase, so the clock restarts when cleanup hands over to matching.
  const importPhase = importStatus?.phase ?? null;
  useEffect(() => {
    if (!importPhase) return;
    const startedAt = Date.now();
    setImportElapsed(0);
    const id = setInterval(() => setImportElapsed(Math.round((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [importPhase]);

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
  // Every store mutation answers with the whole store, so the panel never guesses what the
  // server's upsert did — it just adopts the result.
  const mutatePastReads = async (op: () => Promise<PastReadRow[]>) => {
    setPastReadsBusy(true);
    setPastReadsError(null);
    try {
      setPastReads(await op());
    } catch (e) {
      setPastReadsError(e instanceof Error ? e.message : "Could not save past reads.");
    } finally {
      setPastReadsBusy(false);
    }
  };

  const suggest = usePendingBooks({
    ctx: { scored, members: state.members, body, quality, history },
    // A rescore replaces every card, so the tray — which holds full SNAPSHOTS, not ids — is
    // remapped by id or it renders stale scores. A book the map no longer has keeps its stale
    // card: the organizer's shortlist must never silently eject something being argued for.
    apply: (outcome) => {
      const nextById = new Map(outcome.scored.books.map((b) => [b.id, b]));
      loadRun(state.members, outcome.scored);
      let dropped = 0;
      setTray((t) => {
        const remapped = t.map((b) => nextById.get(b.id) ?? b);
        // Auto-add the new books: they were typed because the room is considering them.
        const added = outcome.addedIds
          .map((id) => nextById.get(id))
          .filter((b): b is ScoredCard => !!b && !remapped.some((x) => x.id === b.id));
        const room = Math.max(0, TRAY_CAP - remapped.length);
        dropped = added.length - Math.min(room, added.length);
        return [...remapped, ...added.slice(0, room)];
      });
      if (dropped > 0) return `Selections are full (${TRAY_CAP}), so ${dropped} stayed on the map only.`;
    },
  });

  const runNow = () => {
    setTray([]);
    setPresent(false);
    setFinalMap(false);
    suggest.reset(); // a queued suggestion must not drop a stale map onto the new run
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
      setLoadedHistory(saved.input.history ?? []);
      setTray([]);
      setPresent(false);
      setFinalMap(false);
      suggest.reset(); // same reason as runNow: the loaded map owns the screen now
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
      // Past reads are typed into the Past reads panel now, not imported. Recognise the old
      // feedback export and say so — parsed as an intake it would invent members out of
      // feedback rows.
      if (isFeedbackCsv(text)) {
        setLoadError("That's the post-read feedback export. Past reads are added by hand now — use the Past reads panel in this drawer.");
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
        setImportStatus({ phase: "cleanup", done: 0, total: 0 });
        const { rules, cleanedConstraints } = await normalizeMembers(imp.members, constraintLines, (done, total) =>
          setImportStatus({ phase: "cleanup", done, total }),
        );
        const base = cleanedConstraints ?? constraintLines;
        const combined = [...base.filter(Boolean), ...rules.map((r) => `${r.member}: ${r.text}`)];
        if (combined.join("\n") !== imp.constraints) setConstraints(combined.join("\n"));
        // Then canonicalize every mentioned book against the books catalog so the cards show
        // "Title (Author)" throughout. Best-effort — a miss just keeps the cleaned string.
        setImportStatus({ phase: "matching", done: 0, total: 0 }); // one batched request — no count to show
        await resolveBookLists(imp.members).catch(() => {});
        setMembers([...imp.members]); // members were mutated in place — new array reference to re-render
      } catch {
        setMembers([...imp.members]);
        setImportWarning("Title cleanup unavailable — using the lists as typed.");
      } finally {
        setImportStatus(null);
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
        <StatusBar state={state} importStatus={importStatus} importElapsed={importElapsed} />
      </div>
      <Help />
      {!viewerMode && scored && <PublishPanel getRun={currentRun} />}
      {viewerMode && scored && (
        <div className="pace-pill" title="Reading pace — only changes your own sessions estimate">
          <span className="muted">pace</span>
          <input type="number" min={10} step={10} value={pace.pages} onChange={(e) => setPace({ ...pace, pages: Number(e.target.value) || pace.pages })} />
          <span>p /</span>
          <input type="number" min={1} value={pace.weeks} onChange={(e) => setPace({ ...pace, weeks: Number(e.target.value) || pace.weeks })} />
          <span>wks</span>
        </div>
      )}
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
          key={finalMap ? "final" : "full"} // a different book set is a different layout, not a pan
          scored={finalMap ? finalMapState : scored}
          finalists={finalists}
          pinnedId={pinnedId}
          onPin={onPin}
          colorOf={colorOf}
          pace={pace}
          rankOverride={finalMap ? rankOf : undefined}
          rankTotal={rankOf.size}
          hideLabels={finalMap}
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
              pastReads={pastReads}
              onAddPastRead={(row) => void mutatePastReads(() => savePastReads([row]))}
              onDeletePastRead={(title) => void mutatePastReads(() => deletePastRead(title))}
              pastReadsBusy={pastReadsBusy}
              pastReadsError={pastReadsError}
              running={running}
              importing={importStatus !== null}
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
          ...(rosterMismatch
            ? [{
                kind: "warn",
                text:
                  `This map was scored for ${rosterMismatch.join(", ")} — not the members in the panel. ` +
                  `Every fit bar you see is theirs. Run to rebuild it for the current roster.`,
              }]
            : []),
          // "Unservable" means no book on the map reaches fit 7 for them — a real signal, but
          // the old wording ("no good pick found") read like a failure. Name the threshold, and
          // at `test` say what usually causes it: low effort scores conservatively, so 7s are
          // rare and half the group can land here on plumbing runs.
          ...(scored && scored.selection.unservableMembers.length > 0
            ? [{
                kind: "warn",
                text:
                  `Nothing on the map is a strong match (fit 7+) for ${scored.selection.unservableMembers.join(", ")}` +
                  ` — they're covered by weaker picks.${quality === "test" ? " The test preset scores low across the board; standard is the honest read." : ""}`,
              }]
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

      {scored && !viewerMode && (
        <SuggestBar
          members={state.members}
          pending={suggest.pending}
          onAdd={suggest.add}
          onRemove={suggest.remove}
          onRescore={suggest.rescore}
          checking={suggest.checking}
          scoring={suggest.scoring}
          mapSize={scored.books.length}
          status={suggest.status}
        />
      )}

      {scored && (
        <Tray
          tray={traySorted}
          pace={pace}
          rankOf={rankOf}
          onRemove={removeFinalist}
          onPresent={() => setPresent(true)}
          onFinalMap={() => setFinalMap((f) => !f)}
          finalMap={finalMap}
        />
      )}

      {present && traySorted.length > 0 && <Present tray={traySorted} pace={pace} onClose={() => setPresent(false)} />}
      {!viewerMode && promptOpen && <ShowPromptModal body={body} onClose={() => setPromptOpen(false)} />}
    </div>
  );
}

/** CSV import phases worth watching: Stage-0 cleanup counts its items, catalog matching is one
 * batched request with nothing to count. */
interface ImportStatus {
  phase: "cleanup" | "matching";
  done: number;
  total: number;
}

const importLabel = (s: ImportStatus, elapsed: number): string => {
  const head = s.phase === "matching" ? "matching titles" : s.total > 0 ? `cleaning up ${s.done}/${s.total}` : "cleaning up";
  return `${head}… ${elapsed}s`;
};

function StatusBar({
  state,
  importStatus,
  importElapsed,
}: {
  state: RunState;
  importStatus: ImportStatus | null;
  importElapsed: number;
}) {
  // Idle and done show nothing — once the map is up it should speak for itself. The import
  // status only shows outside a run (they can't overlap: Run is disabled during an import).
  if (state.status !== "running" && state.status !== "error") {
    if (!importStatus) return null;
    return (
      <div className="statusbar running">
        <span>
          <span className="spinner" /> {importLabel(importStatus, importElapsed)}
        </span>
      </div>
    );
  }
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
  // Stage 1 is minutes of parallel lens calls with nothing to show; the counter is the sum
  // across lenses, and a failed lens drops out of the denominator rather than stalling it.
  if (!v) {
    const passes = Object.values(state.lenses);
    if (passes.length === 0) return "scouting books…";
    const lines = passes.reduce((s, p) => s + p.lines, 0);
    const quota = passes.reduce((s, p) => s + p.quota, 0);
    const failed = passes.filter((p) => p.state === "failed").length;
    return `scouting ${lines}/${quota}${failed ? ` · ${failed} lens failed` : ""}…`;
  }
  if (v.resolved < v.total) return `verifying ${v.resolved}/${v.total}${v.dropped ? ` · ${v.dropped} dropped` : ""}`;
  if (!state.scored) {
    const s = state.scoreProgress;
    return s ? `scoring ${s.scored}/${s.total}…` : "scoring…";
  }
  return "finalizing…";
}
