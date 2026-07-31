# Engineering notes

Living doc: architecture, decisions, tuning constants, and milestone status. Kept current
each milestone.

This is the decision record, not a tutorial — it's here because the *why* behind a choice
(and behind the several choices that got reverted) is the part that's hard to recover from
reading the code. If you're setting the app up, start with [SETUP.md](../SETUP.md) instead.

## Architecture (one process)

SPA (browser) → Express API (`/api`) → pipeline. In prod one Node process serves the built
client and the API on one port; in dev, Vite (`:5173`) serves the client and proxies `/api`
to the server (`:3000`).

Pipeline: **Stage 1** (Claude → candidates) → **Stage 2** (Open Library → verify + enrich) →
**Stage 3** (Claude → per-member scores) → **selection** (pure server-side math) → client
renders a cover map.

Run progress streams to the browser over **SSE** (`POST /api/run` → `text/event-stream`,
read client-side with `fetch()` + `ReadableStream`). Event union: `run_started`,
`candidates`, `verify_progress`, `scored`, `warning`, `error`, `done` (see
`shared/src/types.ts`).

## Key decisions

- Stack: React + Vite + TS client, Node + Express + TS server, one process, not serverless.
- No app-wide access gate (no server-side personal data); keep IP rate limit + max-effort
  passphrase.
- Books: **Open Library only** for now; page count = median of English editions; `null`
  pages is first-class ("?"), never a reason to drop a book.
- Saved runs: URL-based (data + cover URLs) for now.
- Finalists: click "Add to finalists" primary; native drag optional.
- Provenance badge: "member-nominated (by X)" vs "Claude's own pick".
- Member intake (Tally form): `{ name, paragraph, suggestions[], alreadyRead[], loved[] }`.
  suggestions → candidate seeds; alreadyRead → hard exclusion; loved → taste signal.
- **Cost policy: cheapest + frugal.** Default `ANTHROPIC_MODEL=claude-haiku-4-5`,
  `ANTHROPIC_EFFORT=low`; scarce API credits, so minimise live calls in dev (unit tests +
  the no-cost Show-Prompt first, then 1–2 real calls to confirm). **Haiku 4.5 does NOT accept
  `output_config.effort`** — the Claude client (M2) must omit effort AND extended thinking for
  Haiku (only Opus/Sonnet-tier take effort). Up the model at deployment.

## Tuning constants (the "dry-run dial" — live in `pipeline/selection.ts`)

- Scoring blend: `quality = 0.8·avgFit + 0.2·discussability − lengthDiscount` where the
  discount is 0.1 per (pages−200)/60 step, capped at 1.0; unknown pages are never penalized
  (added 2026-07-19 to slightly favour shorter reads).
- Serve threshold: member M is "served" by a book if `fit(M) ≥ 7`; every member wants ≥ 2.
- Quality min = **6.0** (retuned down from 6.5 at M19 — the anchored Stage-3 rubric scores
  honestly lower, and the old threshold left the map stuck at the 15-book floor); display
  floor/target/ceiling = 15 / 20 / 25; solo mode uncaps.

## Milestone status

- **M1 — scaffold + streaming skeleton — DONE.** Monorepo (npm workspaces: shared/server/
  client), fail-fast zod env, `/api/health`, SSE plumbing driven by a stub pipeline
  (`run_started → candidates → done`), `POST /api/run/preview`, input panel, live sessions
  math, `Member[]` parser + 19 passing tests. Verified: typecheck, tests, SSE streams
  incrementally (direct and through the Vite proxy), disconnect aborts cleanly, 400/403
  gates, client build, single-process prod serving (SPA + API + fallback on one port).
  - **Gotcha 1 (env):** an exported-but-empty `ANTHROPIC_API_KEY=""` (present in this shell)
    clobbers `.env` because dotenv won't override an already-set var. `config.ts` treats
    empty env vars as unset so `.env` fills them; a real non-empty env var still wins. It
    also loads the repo-root `.env` by path (npm runs the server from `server/`).
  - **Gotcha 2 (SSE abort):** use `res.on("close")` (guarded by `!res.writableEnded`), NOT
    `req.on("close")` — for a buffered POST body the latter fires when the body is read and
    would abort our own run.
- **M2 — Stage-1 candidates + Show-Prompt — DONE.** Real Claude Stage-1 generation via a
  capability-aware client (`claude/client.ts`: omits `output_config.effort` + thinking for
  Haiku; passes the key explicitly; guards `refusal`; hand-written JSON schema + zod validate,
  decoupled from zod-v4). Server-side seeding of member suggestions, already-read exclusion,
  and dedup (`pipeline/candidates.ts`). `POST /api/run/preview` returns the real assembled
  Stage-1 prompt (no API cost) → Show-Prompt modal. Verified on Haiku: 26 candidates in ~7s,
  seeding/exclusion/dedup correct, no console errors, ~$0.003/run.
  - **Observation:** Haiku's raw candidates include some hallucinations / wrong attributions
    (invented titles, wrong author) — exactly what **Stage 2 (M3) verification** filters; on a
    cheap model the verifier carries the quality, not the model. Also saw an `Author: Title`
    artifact in one title → **M3's Open Library matcher must tolerate author-in-title.**
- **M3 — Stage 2 verify + covers — DONE.** Open Library search (`q=title author`, one request/
  book, `number_of_pages_median` → pages), bigram-dice matcher with author disambiguation +
  author-in-title handling (`books/match.ts`), concurrency-capped verify (`pipeline/stage2.ts`)
  streaming `verify_progress` per book; client renders a cover grid with real covers, hashed
  placeholders + "verify" badge, year/pages/sessions, and hides dropped hallucinations (with a
  count). Verified live on Haiku: 26 candidates → ~22–23 kept, 3–4 dropped, covers resolve, no
  console errors.
  - **Fixes found by driving:** (1) never overwrite a MEMBER's stated author with OL's — OL
    editions sometimes list a publisher (e.g. "Mariner Books"); member noms keep their author
    and only verify when OL confirms it; (2) widened OL search to `limit=10`; (3) eager cover
    loading (lazy left below-fold covers blank).
  - **Known limitation:** for CLAUDE picks we still adopt OL's author, so a wrong OL match can
    attach the wrong book (e.g. "The White Hotel" matched an art book, not the D.M. Thomas
    novel). The "verify" badge on cover-less / low-confidence books is the safety net; tighten
    in a later pass if it proves noisy.
- **M4 — Stage 3 scoring + selection — DONE.** Second Claude call rates each verified book per
  member (+ discussability, cluster label, complexity, comfort/stretch, one-liner, discussability
  line, rationale, expedition), keyed by id (`pipeline/stage3.ts`, `prompts/stage3.system.md`).
  The SERVER computes avg-fit, `quality = 0.8·avgFit + 0.2·disc`, threshold + floor/ceiling, the
  "every member served by ≥2" override (pulls), servesMost, clusters, coverage — pure + unit-
  tested (`pipeline/selection.ts`, 7 tests). Client shows a cluster-grouped scored view (bands,
  avg-fit + serves-most, coverage chips, expedition/pulled badges; shared `Cover` component).
  Verified live on Haiku: 15 books across ~3–6 clusters, both members served ≥2, no console
  errors.
  - **Notes:** Stage-3 latency on Haiku is ~30–45s for a 2-member run (the "scoring…" status
    covers it; a 10-member run will be longer — consider streaming Stage 3 later). Cluster labels
    sometimes fragment into singletons — could nudge the prompt to consolidate. Scoped the card
    entrance animation to the verify grid so scored cards render at full opacity.
- **M5 — Cover map + hover cards — DONE.** Studied the live hnbooks reference (embeddings →
  PaCMAP → HDBSCAN → OpenLayers packed circles over 1000 books — an explicit non-goal here);
  took the aesthetic (size = score, color = cluster, dense warm canvas) and built it as CSS
  cluster bands: labeled + color-coded (`lib/palette.ts`), covers sized by avg-fit rank
  (`lib/mapsize.ts`, 96–176px), bottom-aligned "shelf" reflow, per-cover cluster-color accent.
  Edge-aware hover/tap detail card (`HoverCard`): title/author/year/pages/sessions, complexity,
  comfort|stretch, one-liner, provenance, the **per-member fit spread (bars)**, discussability
  line, rationale, expedition, verify. Shared `Cover` (now size/accent-aware). Verified live: 17
  books, 5 colored bands, cover sizes span 96–176, hover card shows all fields incl. Alice 10 /
  Ben 7, no console errors. Removed the superseded ScoredView + its dead CSS.
  - Note: the pinned hover card captures position at open and doesn't follow scroll (fine for a
    glance; revisit if it matters on the projector).
- **M6 — Finalists tray + present mode — DONE.** Add up to 3 finalists via a one-click "+" on
  each cover, the hover card's Add/Remove button, or native drag onto the tray (cap enforced +
  removable; `lib/finalists.ts`, `Tray`). A sticky bottom tray shows the picks with a Present
  button. Present mode (`Present`) is a full-screen advocacy view: big cover, the prominent
  reading-commitment line (pages · sessions at pace), tags, summary, Discuss/Why, per-member
  fits; ‹/› + arrow keys to move, Esc to close. Verified live: added 3, 4th disabled, present
  nav 1/3→2/3, no console errors. Tray/present reset on a new run.
- **M7 — Save/Load (offline) + solo — DONE.** Save downloads the whole run as JSON
  (`lib/savedRun.ts`: `SavedRun` v1 = input + members + `scored`, cover URLs included); Load
  parses/validates it (`parseSavedRun`, 5 tests) and re-renders via a `load` reducer action +
  `useRunStream.loadRun` — no server, no API. Save/Load buttons in the input panel. Verified
  live: ran → saved → reloaded → **went fully offline** → loaded the file → map + present
  rendered from JSON alone (covers degrade to placeholders per Decision 4). Solo: one member →
  `soloMode` uncaps the display (18 books, past the 15 floor) with a "· solo" status. Fixed a
  "done · N books · ms" cosmetic (loaded runs carry no duration).
- **M8 — Hardening + prod — DONE.** In-memory per-IP sliding-window rate limit + a global
  run-slot semaphore (`ratelimit/rateLimiter.ts`, 3 tests); `run.ts` returns 429 (+Retry-After)
  / 503 / 403 before the stream opens, with a constant-time (`timingSafeEqual`) max-effort gate.
  `compression()` on all routes except the SSE stream. A `warning` SSE event fires when Open
  Library is widely unreachable → non-fatal client banner (`state.warnings` + `.banner.warn`).
  Single-process prod build verified: `npm run build && npm start` serves the SPA, static
  assets, SPA fallback, and `/api` on one port; `Dockerfile` + `.dockerignore` added. Verified
  live (zero API cost): prod serving, effort=max → 403, next run → 429 + Retry-After.

**All 8 milestones complete.** 55 passing tests.

- **Tally CSV import — DONE (client-side).** `client/src/lib/tallyCsv.ts`: a small RFC-4180-ish
  `parseCsv` + `tallyCsvToMembersText` that maps columns **by header name** (so a trimmed export
  with only the relevant fields still works) into the `Name: paragraph` block format the server
  already parses — transparent + editable in the textarea, reusing the whole pipeline. Per-member
  "#pages per two weeks" → a group pace hint (median of members' lower bounds). "Load CSV" button
  + an info banner. 5 tests. Verified live on the real example export: 1 member → pace 50 → a
  clean, on-topic 16-book / 8-cluster solo run, no console errors.
  - **Book-list column mapping — RESOLVED.** The Tally headers arrive truncated ("Concretely",
    "List books…", "List books… (2)"), so which is suggest / already-read / loved was a guess at
    first. Confirmed against the real form and now fixed in code: paragraph ← "interested in
    reading" (+ the belief question); **loved** ← "Concretely"; **already-read** ← "List books…";
    **suggest** ← "List books… (2)"; "Anything else?" → the constraints box. Change the mapping in
    one place (the block in `tallyCsvToMembersText`) if your own form orders its questions
    differently — [SETUP.md](../SETUP.md) lists the exact header keywords each column matches on.

## Redesign — hnbooks-style packed map + 3-panel workspace

Reworked the UI to match the live reference (hnbooks.pieterma.es): a full-viewport workspace with
a **left book-preview rail**, a **centre packed-cover map**, a **right collapsible input drawer**,
and a **bottom finalists bar**.

- **The map** is now a scatter of **domain blobs** instead of horizontal bands. `lib/mapLayout.ts`
  (pure, 5 tests) packs each cluster's covers with **phyllotaxis** (best-fit book largest, in the
  centre) and packs the blobs along a **domain-ordered spiral** (canonical `DOMAIN_ORDER`, so
  related domains land near each other). Output is world units; `CoverMap` measures its stage with
  a `ResizeObserver` and `transform: scale()`s the whole world to fit. Cover size = avg-fit.
  Tuning knobs: `spread` 0.84, `BLOB_GAP` 20, scale clamp [0.3, 1.8].
- **The honest gap:** the reference positions books by *embeddings* (PaCMAP → HDBSCAN → OpenLayers),
  an explicit non-goal. We reproduce the *look* (packed domain blobs, labels, mosaic covers)
  deterministically; the domain-ordered spiral gives rough semantic adjacency, but within/between
  blobs is not embedding-true. Fine at our scale (tens of books, not 1000).
- **Domain clusters:** Stage-3 prompt now asks for a broad subject DOMAIN (History, Science,
  Fiction…). Haiku still splits an all-one-field input into sub-domains ("Philosophy of Mind"); a
  diverse group yields real domains. Push the prompt / a stronger model if it stays too fine.
- **Preview rail** (`PreviewPanel`, from the old HoverCard): hover a cover → full detail on the
  left; click → pin. **Finalists**: green ring + ✓ on the map, the bottom bar, and Present unchanged.
- Removed `HoverCard`/`mapsize` (dead). Verified live: CSV → run → packed map, drawer collapse,
  hover preview, 3 finalists, present — 60 tests, no console errors.

## M9 — Semantic embeddings + movable canvas

- **Real embeddings position the map.** After selection, the orchestrator embeds each selected
  book (`title — author. summary rationale (domain)`), mean-pools per cluster, and projects the
  cluster vectors to 2D. `server/src/embeddings/client.ts` is provider-agnostic: default **local**
  `Xenova/bge-small-en-v1.5` via `@huggingface/transformers` (no key, no per-run cost, offline;
  lazy-loaded once); `voyage`/`openai` via `fetch` behind `EMBEDDINGS_PROVIDER` + `EMBEDDINGS_API_KEY`.
  `server/src/pipeline/project.ts` (pure, 5 tests) does classical MDS via **dual PCA** (top-2
  eigenvectors of the centered Gram matrix — PSD, so power iteration is safe) → normalized [0.08,0.92]
  `centroid` per `Cluster` (new optional shared field; flows through `scored` → `ScoredState` →
  saved JSON, so offline reload keeps positions). **Best-effort:** any failure (provider error,
  `EMBEDDINGS_PROVIDER=none`) leaves centroids absent → client falls back to the domain spiral. A
  run never fails over embeddings.
- **Clusters by TOPIC, consolidated at the knee.** Stage-3 groups by subject matter, not genre/form.
  Because Haiku over-splits into singletons and won't merge on instruction, `consolidateClusters`
  (project.ts) agglomeratively merges the two most-similar clusters (by embedding centroid) all the
  way down, recording each merge's similarity, then cuts at the **knee** — the merge farthest above
  the first→last chord (Kneedle; more robust than "largest single gap", which one very-tight initial
  pair fools). Bounded to [2, min(8, n)]. Deterministic, relabels moved books. HN-flavoured mock
  group → **4 topic clusters** (Science Fiction / Business / History / Engineering).
- **Details on hover.** Hovering a cover shows a floating `HoverCard` next to it (display-only,
  `pointer-events:none`); clicking pins the book into the left rail (`PreviewPanel`) for the Add
  action. Both share `BookDetail`. The preset input is now an HN-flavoured 5-member mock group.
- **Covers pack adjacent, never overlapping.** `packBlob` places the best-fit cover in the centre
  and the rest on a greedy outward spiral at the first spot clear of placed covers (rectangle
  collision, `coverClear` + `COVER_GAP`) — replaces the sunflower packing that overlapped.
- **Client layout** (`lib/mapLayout.ts`): when every cluster has a `centroid`, blobs are placed from
  the (scaled) centroids + a deterministic **overlap-removal relaxation** (push-apart, preserves
  relative arrangement); else the domain spiral. `span = 2.2·√(Σr²)` keeps the world compact so
  fit-to-stage covers aren't tiny.
- **Movable canvas** (`CoverMap.tsx`): `view = {scale,tx,ty}` — drag to pan, wheel to zoom toward
  cursor (native non-passive listener), click-vs-drag threshold so cover clicks still work, "Fit"
  button + double-click. The fit transform is computed **once per layout**, NOT on resize/collapse,
  so **covers keep a stable pixel size** when the window resizes or the drawer collapses (resize
  reveals more canvas). Covers dropped `draggable` (pan takes the gesture).
- **Auto-collapse** (`App.tsx`): a guarded effect collapses the input drawer when `scored` arrives
  (reset per run/load), handing the screen to the map for the projector.
- Verified live (drive): 6 clusters all with centroids, semantic positions (Philosophy of Mind /
  Ethics / Mathematics cluster; Philosophy of Science off on its own), auto-collapse fires, covers
  28.3→28.3px across collapse AND window resize, zoom 28→70px, save→reload offline keeps positions.
  68 tests, no console errors. (Local model ≈ MiniLM+; API is a one-file swap — see Decision 1 in
  the plan. `EMBEDDINGS_PROVIDER=none` fallback is unit-tested, not live-fired.)

- **M10 — Data quality on real submissions — DONE** (autonomous, ~$0.03 total API spend).
  - **Stage 0 — AI title normalization** (`POST /api/normalize` + `prompts/normalize.system.md`,
    client `lib/normalize.ts`): one Haiku call at CSV import fixes typos ("Kinds of Mind" →
    "Kinds of Minds — Daniel Dennett"), extracts embedded authors ("Graeber/Wengrow: the dawn of
    everything." → "The Dawn of Everything — David Graeber, David Wengrow"), drops prose
    fragments, marks uncertain entries `unsure` (never invents). Corrections land in the editable
    textarea; failure → proceed with raw strings. Live on the real export: **fixed 42 titles,
    dropped 6 notes, 4 left as typed**, ~9s, ~$0.002. *(The `unsure` kind was later removed — see
    M15; Stage-0 now parses rather than judges existence.)*
  - **Embedding-first clustering** (`project.ts clusterBooks` + `pipeline/clusterNames.ts`):
    books cluster DIRECTLY on their local embeddings (Ward cost + Kneedle knee, floor 4 at ≥12
    books, cap 8; embed text = title/author/summary/discussLine — no rationale/label); a tiny
    Claude call (~$0.001) NAMES the groups (majority-Stage-3-label fallback). Replaces
    `consolidateClusters`. Real data: the 18-book "Philosophy" megacluster became 7 balanced
    topics ("Moral Foundations & Obligation", "Futures & Systemic Risk", "Systems Thinking &
    Complexity", …) — the hnbooks architecture proper.
  - **Dedup**: `dedupeByWork` now has a canonical-title second pass (dice ≥ 0.9 OR guarded
    containment ≥12 chars + author-compatible) — merges the Graeber pair and subtitle variants;
    identical titles by different authors stay separate. Real payload: 25 → 24 books.
  - **Constraints**: "Anything else?" now fills the CONSTRAINTS box as `Name: note` lines
    (was: buried in paragraphs).
  - **Google Books fallback** (`books/googleBooks.ts`): fills covers/pages and rescues
    OL-unknown titles, mapped onto the OL doc shape so the matcher is shared. **Requires
    `GOOGLE_BOOKS_API_KEY`** — verified live that anonymous quota is now ZERO
    (`quota_limit_value: "0"`), so keyless we skip GB entirely. Also fixed: query terms must be
    space-separated (a "+" gets %2B-encoded and silently returns nothing).
  - **Anti-stuck**: match cache persists to `~/.cache/satisfying-books/matches.json` (survives
    tsx restarts); OL 429/503 → one `min(Retry-After, 30s)` wait; Claude connection errors
    retry once (the earlier 3× "Connection error" class). Claude calls now STREAM
    (`finalMessage()`) — a multi-minute non-streaming Stage 3 was getting killed by NAT idle
    timeouts at ~190s; stop_reason `max_tokens` → clean "truncated" error; stage progress logged.
  - **`scripts/replay.mts`**: offline replay harness — captured run → dedup → embed → cluster →
    name → centroids → loadable SavedRun, near-$0 (one naming call). Use it to iterate on
    map/cluster logic without re-running Claude/OL.
  - **Verification status**: 81 unit tests + typechecks green. Server pipeline verified live
    end-to-end twice (logs; 2nd run: 25 books → 7 named clusters). Client verified rendering the
    exact new payload (offline load: 24 covers, 8 clusters, 0 errors). Stage-0 verified live.
    NOT captured in one single browser take: the final drive hit (a) Open Library throttling
    (~7 runs same-day; backoff made verify ~7min) and (b) a Vite dev-only full page reload that
    wiped client state mid-run — impossible in prod (no HMR websocket). Artifact: a loadable
    replayed run, saved outside the repo (run JSON carries member data).

- **M11 — Input UX + polish.**
  - **Member flashcards**: `members: TallyMember[]` is the primary input state in `App`
    (membersText derived via `buildMembersText`); `InputPanel` shows compact, flat **flashcards** —
    name (title) · paragraph (subheader) · only the NON-empty lists with one-word labels
    (loved/suggestions/exclusions), items joined with "·". Tap the card's left/right edge to move
    (Tinder-style); footer has n/N + add/remove. Editing is via the "edit as text" raw mode
    (`parseMembersText` round-trips the block format). Constraints stay a separate box.
  - **Pace policy**: import parses each member's "#pages/2wk" into a low–high range; the planning
    default is the **median of midpoints** (not the slowest), and the panel shows the distribution
    ("members read 50–100 p/2wk · median 88 · slowest 50") so the group can eyeball the
    lower bound without adopting it.
  - **"Effort" → "Claude effort"** label.
  - **Grayscale/clean pass**: primary buttons charcoal (was terracotta), neutral focus rings,
    hover highlights on buttons/inputs/icon buttons; map cluster colors kept (meaningful).
  - **Drag-snap fix** (`CoverMap`): a pan whose pointer-up lands off-canvas now ends cleanly
    (`e.buttons===0` guard + `onPointerCancel`), so re-entering the canvas no longer jumps.
    Verified: `noSnapOnReenter: true`.
  - Verified live (no API): deck renders + edits, CSV→deck+Stage0+pace-dist, offline map render
    (24 books/8 named clusters), pan + no-snap. 85 unit tests green.
  - **Covers**: `GOOGLE_BOOKS_API_KEY` added to `.env`; the GB fallback fills missing covers/pages
    and rescues OL-unknown titles. Live GB verification blocked by a transient Google **503
    backendFailed** outage at test time (key valid; code retries+degrades) — re-verify when up.
  - **Clustering/embedding review** (no code change — current output is coherent): embed text =
    `title — author. oneLineSummary discussabilityLine`, local `bge-small-en-v1.5`; book-level Ward
    + Kneedle knee (floor 4 at ≥12 books, cap 8) → Claude names groups → dual-PCA MDS for 2D.
    Candidate improvements if clustering needs sharpening: fold in books' subject/category tags
    (GB `categories` are cleaner than OL `subject`, which is noisy), or lower the cap to ~6.

- **M12 — Covers fix + clustering levers + pace graph.**
  - **Google Books fixed**: the 503 "backendFailed" was intermittent per-request flakiness (same
    query fails 3× then 200s), not config — verified the key/API work. Switched to a plain
    relevance query (the `intitle:`/`inauthor:` operators 503 more) and **retry up to 5× / 700ms**
    on 503. Verified live: the titles that missed (Fall of Roe, Abundance Klein/Thompson, More
    Everything Forever) now resolve with covers, the matcher rejecting wrong hits.
  - **Subject tags → embedding**: thread `subjects` onto `VerifiedBook` (OL `subject` filtered
    through a junk stoplist; GB `categories`, which are clean). New embed text =
    `title. oneLineSummary subjects` — **drops author** (clusters by author, not topic) and
    **discussabilityLine** (member-facing). Stage-3 `oneLineSummary` bumped to 1–2 topical
    sentences (richer signal, à la hnbooks' multi-sentence descriptions). Cluster **cap 8→6**.
    Offline replay (no subjects in old data) already tightened 8→6 clean clusters.
  - **Pace mini-graph** (`PaceGraph.tsx`): replaced the text line with a compact SVG range chart —
    one row per member (low–high, slowest first), group-median marker. Verified rendering.
  - 85 unit tests green; typechecks clean. Subjects/new-summary need a fresh run to show on the map.

- **M13 — Flashcard + minimalism pass.**
  - Member cards are now compact **flashcards**: flat (no border), name + paragraph, only the
    non-empty lists, lowercase labels **liked / suggestions / exclusions**, book authors in
    parens ("Sapiens (Yuval Noah Harari)"). **Click the card centre** → inline-edit THAT person's
    fields (name/paragraph/lists); click away to finish. Tap left/right edge → prev/next; the
    end edges are inert zones that capture the click so they never fall through to edit. Content
    aligned with the section headers.
  - Typography reduced to one system (15px name / 13px everything, muted labels); all section
    labels lowercased ("Group-wide rules" replaces "Constraints (optional)").
  - **INPUT tab → a minimal "‹/›" chevron** on the drawer edge.
  - **Left preview rail hidden by default** (map full-width); appears only when a book is pinned
    (click a cover) and hides on unpin. Removed the "satisfying books" title + tagline.
  - **Fixed a real pin bug**: `setPointerCapture` on pointer-down retargeted the `click` to the
    stage, so covers never pinned (masked before because the rail always rendered). Now capture
    only starts once a drag exceeds threshold → clicks pin, drags pan.
  - **Claude retry** extended to 529-overloaded / 5xx (not just connection errors), 2 retries.
  - **API-recognition check** (raw form strings, no Stage-0): 37/46 book-ish strings resolve
    (OL 31 / GB 6), 36 with covers. The 9 misses are 4 prose fragments (Stage-0 drops them) + 3
    parse artifacts Stage-0 fixes ("Bird"→Bird by Bird, bare "Abundance", "Kimmerer: Braiding
    Sweetgrass") + 2 genuinely niche foreign titles (toxisch reich, Chapayev and Void → verify
    badge). So with normalization ≈ all real books resolve except a couple of niche ones.

- **M14 — Book recognition fix. 87% → 94% verified-with-covers on the real form.**
  Root cause: Stage-0 hallucinated authors for title-only entries ("The Authority Gap" → the wrong
  "Tim Harford"), and the author-match gate then rejected the CORRECT book. Fixes:
  - Stage-0 now returns **`authorFromText`** (did the author appear in the member's text, or was it
    inferred?). The client keeps the author only when `authorFromText` — an inferred author is
    dropped, so it's a title-only search the books API resolves (then fills the correct author).
  - `verifyCandidate` is cautious about a mismatched author ONLY when the member actually **typed**
    one (`isMember && c.author && !authorMatched`); a title-only nomination with a strong title
    match is trusted. `enrich` uses the API author when the member didn't type one.
  - **Title-only fallback search** (OL + GB): if `title author` finds nothing, retry title-only —
    a wrong author no longer buries the real book.
  - `splitList` splits "Author: Title. Author: Title." runs (one member's 3 books were glued into one)
    and strips a stray trailing period. Cache keyed off normalized title|author, so title-only
    queries get fresh keys.
  - Result (faithful `verifyCandidate` run on the 2026-07-16 form): **44/47 verified, 43 covers.**
    The 3 remaining are genuinely niche/foreign (toxisch reich [de], Chapayev and Void [ru],
    The Consumer Society) → they get a "verify" badge (correct — flagged, not wrong-matched). 87 tests.

- **M15 — Stage-0 reframed to PARSE, not fact-check.** The `unsure` kind was Stage-0
  deciding existence from Haiku's stale knowledge — it flagged real 2024–25 / foreign books it
  didn't recognize. Now Stage-0 only decides book-vs-prose (structural); the **books API is the
  existence authority**. `kind` enum dropped to `["book","not_a_book"]`; prompt says "when in
  doubt, it's a book." On the 2026-07-17 (8-member) form: **63 books, 6 prose dropped, 0 real books
  lost → 100% classification, 61/63 verified.** Sonnet (`NORMALIZE_MODEL`) gives an identical
  result — the model was never the bottleneck, so Haiku stays default.
  - **Catalogued-title remapping:** a foreign/translated/transliterated title that catalogs list
    under a different English title is remapped to the catalogued name (e.g. "Chapayev and Void" →
    "Buddha's Little Finger", Pelevin) so it verifies. Guardrail: only when the mapping is genuinely
    known, and NEVER for an ordinary English title (even a UK-vs-US alternate) — remapping one that
    already resolves risks routing the matcher to a worse match. Verified on the real string:
    "Chapayev and Void by Viktor Pelevin" → "Buddha's Little Finger" → OL cover 106475, author
    matched. Remaining flagged: "Toxisch Reich" [de] — no English catalogued alternate to use, so
    left as typed (honest verify badge).

- **M16 — Rules rescue + richer summaries + label clarity.**
  - **Prose rules → Constraints** (design call: liked lists stay taste-only — the form's
    "Concretely" asks for *loved* books, members prove it: a member's "Loved is a strong word…",
    a member listing Scout Mindset as loved AND don't-redo, another banning the Russian classics they
    loves; seeding candidates from loved would misattribute "Suggested by X" to books X banned).
    Instead the real (a)-side bug is fixed: Stage-0 gained **kind "rule"** — actionable prose in a
    list ("as well as anything from Russian classics") now moves into the Constraints box as
    "Name: text" instead of being silently deleted. Banner: "moved N rules to Constraints".
  - **`summary` replaces `oneLineSummary` + `discussabilityLine`** — two short paragraphs
    (what it argues; how readers receive it, ~70–110 words, Goodreads-blurb register). Embeds and
    cluster naming use paragraph 1 only (reception prose reads alike across books and would blur
    topic geometry). Saved-run loader migrates old files (`oneLineSummary` → `summary`).
    Cost: ~+4k out tokens/run (~+$0.02 Haiku).
  - **UI:** done-status line hidden (map speaks for itself; unservable-members note moved to a
    warn banner since the SERVED chip row is gone); hover card measured then clamped fully inside
    the viewport; provenance reads "Suggested by X" / "Claude pick"; badges are two-word
    ("moderate read", "stretch pick", "long expedition", "needs verify") with resting tooltips
    (`lib/labels.ts` centralizes label+info for rail/hover/present); sidebar identity block
    (title/author/facts/badges) centered, content reordered: identity → badges → summary → fit
    bars → scores → why → act. 91 tests.

- **M17 — hnbooks-style chrome + resolved suggestions + quiet banners.**
  - **Full-bleed map, translucent panels:** `.map-stage` spans the whole viewport; the preview
    rail, drawer (+ its toggle), tray, and Fit button float above it translucently
    (rgba ~0.8 + backdrop blur), borders/shadows next to the sidebars removed — the map showing
    through is the only separation (the reference's look). Pre-map views (`.stage-scroll/idle`)
    pad themselves clear of the floating panels.
  - **`POST /api/resolve`:** canonicalizes book refs against OL/GB (cache-first, exported
    `resolveMatch`/`resolveGbMatch` from stage2, BOOKS_CONCURRENCY worker pool, $0 Claude). At CSV
    import the client resolves each member's SUGGESTIONS and rewrites them "Title — Author", so
    the cards show the matched "Title (Author)" the map will use; member-typed authors are kept,
    missing ones filled from the catalog. Best-effort, silent on miss.
  - **Quiet on success:** the blue import info banner is gone (the cards updating IS the
    feedback); only failures banner now (cleanup unavailable → warn, CSV unreadable → error,
    unservable member → warn). Streaming badge "nom · X" → "sugg · X".
  - **Badges intelligible + click popovers:** "easy/medium/heavy read", "safe bet"/"wild card",
    "long haul", "needs verify"; explanation opens on CLICK as a styled mini popover
    (`Tag` component; hover-dwell native tooltips dropped — unreliable on projector/trackpad).
  - **Zen pass:** member-card actions are glyphs (`+` / `−` / `edit|done` link, card body no longer
    click-to-edit); drawer chevron sits INSIDE the drawer's top-right (floats at the screen edge
    when collapsed — same rule); the four ghost buttons became a quiet lowercase text-link row
    (Run is the only real button); field labels/tray/fit lowercase; thin overlay scrollbars.

- **M18 — every mentioned book resolved + matcher fix.**
  - `/api/resolve` now canonicalizes ALL three lists (liked/suggestions/exclusions), so cards read
    "Title (Author)" throughout; `titleCase` guard (small-words-aware, preserves existing casing,
    unit-tested) keeps member-typed lowercase titles capitalized. Badge popovers open INSTANTLY on
    hover (tap toggles on touch). Streaming badge shows just the member's name (green = suggested).
    The edit/done link sits inside the card's bottom-right. Stage-3 summary target raised to
    ~110–150 words (was ~70–110; user wanted the fuller Goodreads-blurb length).
  - **Matcher fix (affects Stage 2 too):** catalog titles carry edition qualifiers — Rand's work
    is listed as "Atlas Shrugged (Centennial Ed. HC)", which scored BELOW an exact-titled audio
    edition credited to its narrator ("Anne Williams"), so title-only author-fill picked the wrong
    author. `pickBestMatch` now strips trailing parentheticals from doc titles before comparing;
    regression test with the real OL doc shapes; poisoned disk cache purged (repopulates).

- **M19 — pipeline refinement: lens split, rule filter, feedback loop.**
  - **Stage 1 split into three parallel lens passes** (user's rewritten base prompt, shared user
    prompt, per-lens system + ask): *champions* (exactly 2 books per member, that member alone —
    guarantees minority tastes), *bridges* (8 books serving ≥2 members), *wildcards* (8 recent /
    non-Anglo-mainstream / unexpected-angle finds). Union deduped server-side; one failed lens
    degrades the pool instead of failing the run; solo mode skips bridges and scales champions
    (quota: 2 at ≥4 members, else ⌈8/n⌉). Constraints REMOVED from Stage 1 entirely.
  - **Constraint filter pass** (new, post-verification): one cheap Haiku call judges verified
    books (id/title/author/year/pages) against the group rules — conservative by prompt (only
    CLEAR violations; taste preferences explicitly ignored), removals surfaced as a warn banner,
    any failure keeps all books. Live check: Dead Souls removed under "no Russian classics",
    L'Étranger under "German or English", Thinking in Systems kept.
  - **Input preprocessing:** /api/normalize also cleans member paragraphs + constraint lines
    (pleasantries/meta like "thank you for organising!" stripped; content kept verbatim; a
    cleanup can never delete a real paragraph). Cleaned text lands in the editable cards.
  - **Stage-3 scoring rubric:** anchored fit bands (9–10 quotable hook … 5–6 DEFAULT on no
    signal … 1–2 against preferences), "never 7+ without a concrete hook in the member's own
    words", independence across members, anchored discussability; past-read feedback calibrates
    fits. maxTokens 32768 → 48000 (Haiku caps at 64K) for the bigger pool.
  - **Feedback loop:** the same "load csv" link detects the post-read feedback form (headers:
    name / book / finish / satisfaction / feedback), groups rows into PastReads (finish count,
    avg rating, notes), shows them under Constraints ("Past reads … clear"), sends them with the
    run (`RunRequest.history`), excludes past reads from candidates AND from seeded suggestions
    (fixed a pre-existing hole: seeded nominations bypassed the exclusion set), and feeds the
    notes to Stage 1 + Stage 3. SavedRun carries history.
  - **Liked books seed candidates ("Liked by X"):** new provenance `member_loved` — members'
    liked lists join the pool as personally-vouched champion picks (quality proven for one real
    member), with honest attribution distinct from "Suggested by X". Precedence: suggestion >
    liked > Claude pick (dedupe merge keeps the strongest badge); exclusions and past reads
    beat both; the rule filter catches liked-but-banned books (the Russian-classics ban).
    Verification treats liked entries with the human-typed caution (kept unverified on
    no-match, never dropped). Rationale: the two prior objections (misattribution, banned
    books surfacing) got mechanical fixes; remaining cost is one member's re-read vs proven
    quality for seven — measure the net effect with the feedback CSV after a real cycle.
  - **Self-test fallout fixed:** (1) normalize now reconciles entries by the echoed `original`
    (models drop an entry mid-list at ~70 entries; positional strictness 502'd the whole
    cleanup — now a dropped echo degrades to as-typed); (2) the filter invented a page-count
    rule from "I read with Kindle" / "can't read heavy books in German" twice — fixed with
    calibration examples naming that exact phrasing, a no-hedged-reasons rule ("may/borderline"
    → don't mark), and a misfire guard (>⅓ of the pool removed → skip the filter);
    (3) QUALITY_MIN 6.5 → 6.0 (the anchored rubric scores honestly lower; the old threshold
    left the map at the 15-book floor); (4) summaries squeezed to one 44-word paragraph on the
    bigger pool — "every book gets full depth" line restored 2 paragraphs / ~100 words;
    (5) exclusions are now VARIANT-matched (`isExcluded` via titleVariants + leading-article
    tolerance, plus a post-verify sweep over canonical titles) — a subtitled liked entry and a
    lens proposal without "The" both slipped past the bare-title exclusion before;
    (6) banners dismiss on click — a long rule-filter banner floated over the map and blocked
    clicks on the covers beneath it; (7) the filter call runs on Sonnet by default
    (FILTER_MODEL, ~$0.005/run) — after four prompt iterations Haiku still misapplied rules
    (removed a German book under "German or English", confused Ord's Precipice with
    Goncharov's, listed a violation whose own reason said "no violation"); Sonnet is 3/3 clean
    on the adversarial set. A hedged-verdict guard drops any violation whose reason contains
    "may/borderline/no violation".

- **M20 — filled-plane map, hedge-strip, deploy prep.**
  - **Filled plane:** per-book 2D positions (`ScoredCard.pos`, same dual-PCA MDS as the
    centroids, applied to every book's embedding) → the map renders one continuous canvas like
    the reference instead of islands; circumscribed-circle overlap relaxation guarantees no
    cover overlaps (verified: 24 covers, 0 overlaps); cluster labels float as click-through
    translucent pills above their covers. Blob layout remains the fallback for old saves.
    Clustering itself proven lossless on real data (24 in → 24 out, each book in exactly one
    cluster); books that vanish from the map are dropped by SELECTION (top ~25 of the scored
    pool), verification, or the rule filter — never by clustering. Replay harness now emits
    positions (and tolerates pre-summary saves).
  - **Hedge/meta-language handling — LLM-ONLY (a deterministic regex strip was tried and
    reverted: real titles begin with hedge words — "Maybe You Should Talk to Someone", "I Think
    You'll Find It's a Bit More Complicated Than That", "Something Like an Autobiography" — so
    only a model can separate the person's words from the book's words).** The normalize prompt
    now carries the decision procedure: judge the WHOLE phrase first (a complete real title
    stays whole), otherwise extract the published work's name and drop the wrapper; an entry
    mixing a vague preference with a named title yields the title as a book, not a rule.
    Verified 6/6 on the adversarial set, 2/2 runs stable.
  - **Deploy:** `render.yaml` blueprint for Render's free plan (Docker, health check,
    TRUST_PROXY, secrets via dashboard) + README "Deploy for free" section (Render caveats:
    15-min sleep, 512MB — EMBEDDINGS_PROVIDER=none if OOM; alternatives: Oracle Always Free
    VM, Cloud Run).

- **M21 — per-member Skip.** Each card gets a `skip`/`include` link (next to
  edit): a skipped member sits the next book out — their paragraph, liked/read/suggest lists,
  AND their named constraint lines ("a member: …") leave the run body entirely (client-side
  filtering; the server never sees them; group-wide constraint lines stay). Skipped cards gray
  out with a "· skipped this round" chip; Run disables when everyone is skipped; skips persist
  in saved runs (`input.skipped` names) while the saved membersText keeps the full roster.
  Their already-read exclusions drop too by design: the group may pick a book only an absent
  member has read. Past GROUP reads (history) always stay excluded. Verified against the real
  request body: skipped member absent from membersText, their constraint line stripped,
  group-wide lines kept.

- **M22 — map semantics pass.** Rationale ("Why:") now references the group's
  shared interests/themes and NEVER member names (per-member fit already has the bars; naming
  names re-reported them and read as favoritism — the widest-paragraph member dominated).
  Cluster membership is inspectable via hover linking: hover a label → other clusters dim to
  0.22; hover a cover → its label goes hot. Labels sit at each cluster's center (relaxed apart
  so pills never merge) instead of above the topmost cover. Covers are equal-size; a
  bowling-style rank badge (black number on white circle, 1 = best) carries the quality signal,
  ranked by the selection's own blend 0.8·avgFit + 0.2·discussability (client mirrors the
  server constant). Fit button → ⛶ icon; a "?" top-right opens a three-line method summary
  (nominate / score / map). Verified on the replayed run: ranks unique 1..24, uniform sizes,
  dim/hot linking, help sections.
- **M23 — hnbooks label style + selections rename.** Cluster names lost the
  translucent pill: cluster-colored text with a tight white text-shadow halo (the
  reference's look; hover linking still spotlights the cluster). Rank badges shrank
  (19px→15px→11px) and moved inside the cover's top-left corner instead of overlapping its
  edge. "Finalists" → "Selections" everywhere user-facing ("Select" / "✓ Selected — remove" /
  "Selections full (3)"); the empty-tray "hover a cover, hit +" hint is gone (internal
  identifiers still say finalists — rename churn wasn't worth it). **Pan-from-cover fix:**
  `<img>` is natively draggable, so press-and-move on a loaded cover started a browser
  image-drag that cancelled the pan (placeholders, being divs, panned fine — why it seemed
  intermittent). `draggable={false}` + `-webkit-user-drag: none` on cover images; the
  never-wired tray drag-drop path deleted. Verified via Playwright on the replayed run:
  drag on a loaded cover pans without pinning, plain click still pins. Follow-up tweaks:
  tray cap 3→5 (`TRAY_CAP` in `lib/finalists.ts` is the single knob; **now 10** — see M32),
  "?" Map paragraph
  reworded (badge = each book's rank, not "marks the strongest pick"; names the
  hierarchical-clustering-on-embeddings method), and the detail card shows "Author · Year"
  on one line with the facts line reduced to pages + sessions.

- **M24 — voting links + scout-mindset forms.** After a run, **share** (top
  right) publishes the SavedRun to the server → `/r/<id>` link + an organizer-only admin
  token. Voters open the link on their own devices (phone-first: the pinned rail becomes a
  bottom sheet with a ✕, pinch-zoom works, hover cards are suppressed on touch), see the
  identical map, and rank up to 5 books into the tray as a ballot (‹ › reorder, position chip,
  name + Submit; resubmitting the same normalized name revises). Voters never see results —
  independent ballots, no anchoring; the organizer's panel polls names-only, then "Compute
  final order" reveals the tally and "Load top 5 into tray" makes it Present-ready.
  **Aggregation is truncated Borda, deliberately no LLM** (counting is closed-form and must be
  recountable in the room): 1st=5 … 5th=1, unranked=0; ties → ranked-by-more-voters → more
  firsts → the shared quality blend (`shared/src/quality.ts`, now the single source used by
  selection, rank badges, and tie-breaks) → title A-Z. Server: `share/{borda,shares,store}.ts`
  (pure logic + cache.ts-style disk persistence with new TTL logic), 4 routes, own rate bucket
  (`SHARE_RATE_LIMIT_PER_HOUR=120` — a venue NAT IP must not starve the run bucket), caps
  (20 sessions / 40 voters / 512kb body), `SHARE_TTL_HOURS=48`. `validateSavedRun` moved to
  shared so the server vets POSTed runs with the client's own rules. **Limits:** sessions
  survive laptop-host restarts (disk) but NOT Koyeb free's scale-to-zero — vote the same
  evening; the link is a capability URL serving the full run (paragraphs, names) to any
  holder — unguessable id + TTL is the mitigation, fine for a friend group; same-name
  collisions overwrite silently (member datalist mitigates).
- **M24 forms.** Intake gains an optional "One belief you hold that you'd like stress-tested —
  or a question where you suspect you might be wrong" question → the parser appends it to the
  member's paragraph ("Belief I'd like stress-tested: …"), so the existing fit rubric
  legitimately rewards challenge-inside-curiosity — no pipeline change, no imposed challenge.
  Feedback gains "Did this book change your mind about anything? Name the belief — or 'none'"
  → merged into the note ("… — Changed my mind: …") so Stage-3 history calibration sees which
  books actually moved beliefs. Both columns are optional and keyword-matched; old CSVs keep
  working. **Discussion practice (no code):** close each meeting with "what did this book
  update for you?" — that answer IS the feedback-form entry. Pocket check: two agreeable maps
  in a row (nothing arguing against a shared belief) → revisit a challenge lens in Stage 1.

- **M25 — UI quality presets.** The "Claude effort" dropdown was a footgun once deployed
  (Haiku ignores effort, so "high" silently did nothing). Replaced by one "Claude" select of
  named presets the SERVER maps to model+effort (`QUALITY_PRESETS` in `domain/request.ts`):
  **test** = Haiku·low (~$0.25/run), **standard** = Sonnet 5·high (~$1), **best** = Opus
  4.8·high (~$2) — **`best` now resolves to Fable 5, see M32**. The client sends only the
  preset name — never a raw model string — so a
  public URL can't request arbitrary expensive models; unknown values fall back to the legacy
  effort path, and no preset yields "max" (still passphrase-gated). The chosen model threads
  through Stage 1 + Stage 3; the constraint filter stays on FILTER_MODEL (already Sonnet) and
  cluster naming stays on the cheap default. SavedRun stores `quality` (old saves with only
  `effort` load as "test"). Default is "test" — the organizer deliberately picks "best" for
  the real monthly run. Also: the Priya/Marcus demo roster is gone; the app boots empty.
  Follow-ups: the cluster-naming call now rides the run's preset model too (Haiku naming
  drifts toward flat subject labels — "Physics", "Biology" — especially via the
  majority-label fallback when the tiny naming call fails; Sonnet/Opus name thematically),
  and the organizer can **reset votes** (DELETE ballots, token-gated) without minting a new
  link — clear the test vote, keep the same URL for the real one.

- **M26 — adversarial hardening pass.** Two independent review agents + a docs sweep over the
  share/vote/preset/pinch stack; all confirmed findings fixed. The big ones: **TRUST_PROXY
  "1" as a string** made Express treat it as an address list, so `req.ip` was the proxy for
  everyone and every per-IP limit was one shared global bucket (numeric strings now coerced);
  a voter named `__proto__` corrupted the ballots record (refused; `Object.hasOwn` for the
  cap check); the Show-Prompt modal ignored quality presets (now `resolveQuality`);
  `/api/normalize` shared the run bucket (own `normalize:`/`resolve:` buckets, 60/h); the
  share store now writes atomically (tmp+rename), flushes on SIGTERM/SIGINT, logs corrupt
  files distinctly from missing ones, and drops malformed disk entries instead of 500ing;
  `validateSavedRun` enforces per-book id/title; ballot revision keeps the voter's original
  order slot; ghost touch pointers can no longer wedge the map into phantom-pinch (primary
  pointer flushes the registry), a 3rd finger no longer corrupts click suppression (and its
  lift rebases the pinch), one tap no longer kills desktop hover on touchscreen laptops;
  revealed results are a SNAPSHOT (stragglers can't reorder mid-announcement; recompute is
  explicit); iOS focus auto-zoom stopped (16px ballot input); the ballot loading/error screen
  no longer crushed at 390px; `isNoAnswer` catches "not really"/"none yet". Deliberately
  left: voters aren't notified of an organizer reset (confirm wording warns; a `resetAt`
  handshake is backlog), 8-hex share ids + unlimited GETs (enumerable in principle, fine at
  friend scale), GET `/api` serving 404 as JSON… fixed via exact-path regex, PreviewPanel's
  unused empty branch (harmless defensive code).

- **M27 — remove in-app voting; one read-only share link.** The group votes in person, so
  the whole ballot machinery went: Borda tally, ballot endpoints/validation, admin tokens,
  results polling/reveal/reset, voter names, the ballot tray footer (~20 tests retired with
  it). What remains is ONE link kind: `/r/<id>` opens the identical map read-only (pan/zoom/
  pinch, pin for details — no Select button, no tray, no run controls); share panel is just
  create + copy. JSON save/load stays as offline persistence, not sharing. Side benefit: a
  link now holds no state worth protecting, so deploys/sleeps mid-evening are harmless
  (re-share costs one click) and the "don't push during a vote" rule is gone. Old
  ballot-bearing disk sessions still load (shape check ignores extra fields).

- **M28 — one main link + organizer gate (replaces per-run share links).** The root URL is
  now the only link: it shows the latest **published** run to everyone, read-only (browse,
  pin, pinch — no controls). `POST /api/publish` (organizer) fills a single persisted slot
  (`~/.cache/satisfying-books/published-run.json`, atomic write + shutdown flush);
  `GET /api/current` serves it openly. With `APP_PASSPHRASE` set, an app-wide middleware
  locks every other `/api` path (constant-time compare, `auth:` bucket 20/h against brute
  force); the client probes `GET /api/auth-check` on boot — 200 means organizer (or gate
  off) — and shows either the full app or the read-only view with an **unlock** button
  ("Organizers only — everyone else just browses the map"). The passphrase is remembered
  per-browser (localStorage) and sent as `X-App-Passphrase` on gated calls; a stale one is
  cleared on boot. `/r/<id>` links, the share store, and `SHARE_*` config are deleted; the
  share button became **publish**. Render caveat: the published run lives on the ephemeral
  disk — after a deploy, re-publish from a saved JSON (one click). HALT: set
  `APP_PASSPHRASE` in Render's env or the deployed app stays fully open.

- **M29 — title-inversion matcher fix.** Real-use bug: "A Brief History of Intelligence"
  (Max Bennett) matched to "Intelligence: A Brief History" (different authors). Root cause:
  the wrong-author escape hatch accepted any doc at whitespace-stripped bigram dice ≥ 0.85 —
  and dice is ORDER-BLIND, so a title inversion (a genuinely different book) scores ~0.92;
  the hatch then "corrected" the author from the catalog, actively installing the wrong one.
  Fix: both no-author-agreement acceptance arms now also require `sameTitleOrdered` — same
  content words in the same order (articles ignored; ONE typo'd/plural token tolerated via
  per-token dice ≥ 0.6). The author-matched arm is unchanged (author agreement is strong
  evidence). Match cache invalidated wholesale (matches.json → matches-v2.json — the old file
  held the poisoned entry). Verified live at $0: `/api/resolve` now returns Bennett's real
  book (via the GB fallback; OL only has a "Summary of…" junk edition). Runs that already
  saved the wrong card keep it — re-run or edit; the matcher just can't repeat it.

- **M30 — subscription (CLI) backend for local runs.** `CLAUDE_BACKEND=cli` makes
  `structuredCall` shell out to the logged-in `claude` CLI (`-p --output-format json
  --system-prompt … --model …`, user prompt via stdin, cwd=tmpdir so no repo context leaks,
  `CLAUDE_CODE_MAX_OUTPUT_TOKENS` per call) instead of the API SDK — the organizer's Max
  subscription covers personal local runs, so exhausted API credits stop mattering. The child
  env strips ANTHROPIC_API_KEY/AUTH_TOKEN/BASE_URL so the CLI can never silently bill the
  API. No structured-output enforcement in print mode, so: schema goes into the system prompt,
  the first JSON object is extracted from prose/fences (`extractJsonObject`), raw control
  chars inside strings are escaped (`escapeControlCharsInStrings` — models emit REAL newlines
  in two-paragraph summaries), zod validates, one corrective retry. "test" maps Haiku→Sonnet
  (the subscription CLI doesn't serve Haiku; cost is covered anyway). The CLI's
  total_cost_usd is NOTIONAL on subscription auth — logged, not billed. Proven live: full
  2-member run end-to-end (3 lens calls + Stage 3 + cluster naming) in 167s, 17 books, $0
  API. **Workflow: run locally (`.env` now sets CLAUDE_BACKEND=cli) → save JSON → open the
  Render app → unlock → load run → publish.** Render itself stays api-mode (no CLI login on a
  host) — serving/publishing the map needs no Claude at all.

- **M31 — cleanup + prompt audit.** Repo-local member-data CSVs and scratch drive scripts
  deleted (submissions are uploaded fresh each cycle; `*.csv` stays gitignored). Dead code
  removed: the pre-lens-split `stage1.system.md`, PreviewPanel's unreachable empty branch (+
  its CSS), the duplicate `.map-fit:hover`, and `useRunStream`'s private `errorMessage` copy
  (now imported from `lib/api`). Every client lib verified to have live importers. **Prompt
  audit verdicts:** filter, clusterNames, normalize, bridges, wildcards — KEPT unchanged
  (battle-tested; no goal gap). One targeted fix survived
  review (user pushback, rightly): stage3's rubric could read a consented challenge as
  "against their stated preferences" (1–2) — it now scores a book that answers a stated
  "Belief I'd like stress-tested" as a stated interest, with NO elevated score target. The
  champions-lens challenge mandate was added and then REMOVED the same day: commandeering a
  personal slot for a counter-book is imposed challenge, which the form-question design
  deliberately avoids — generation stays taste-led, the rubric only stops punishing consented
  challenge. Untested live; the first Fable run is the proof.

- **M32 — first deployed cycle: real-use fixes, payload redaction, rank legibility.** The app
  went live on Render and got used by the actual group; most of this milestone is fallout from
  watching that happen.
  - **Privacy — the open payload is redacted (the one real leak).** `GET /api/current` is
    ungated, and it was serving the WHOLE SavedRun: every member's intake paragraph (including
    the new belief-to-stress-test answers), the constraint lines, and past feedback quotes —
    one curl away for any link holder. Members wrote those for the organizer and the model, not
    for the public. The open endpoint now serves only what the viewer UI renders (scored map,
    member names, pace); the full run stays server-side for the organizer. Plus `robots`
    noindex — a friend-group tool has no business in a search index.
  - **Publish forwarding (`PUBLISH_TARGET` + `PUBLISH_PASSPHRASE`)** makes the laptop workflow
    one click: run locally on the subscription (`CLAUDE_BACKEND=cli`), hit publish, the run
    lands on the hosted app server-to-server (no CORS). The hosted gate's passphrase is a
    SEPARATE var so setting it can't lock the local app.
  - **`best` → Fable 5** (was Opus 4.8), high effort: runs go through the Max subscription
    where the strongest model costs the same, and Fable's edge lands exactly where this
    pipeline needs it — taste judgment and long structured scoring.
  - **Findability fixes from real group use:** the collapsed-drawer toggle was a naked glyph
    next to the pill-shaped "?" (now the same pill — unmistakably a button); member-card ‹ ›
    rested at near-background `#d3d0c8` until hover (now muted ink on a faint strip, always
    visible); and the boot-loaded published map auto-collapsed the drawer, hiding the input
    panel behind that invisible toggle at the start of EVERY session — boot no longer
    collapses, only a fresh run hands the screen to the map.
  - **Four real-run findings:** (1) a transient normalize failure silently shipped "off top of
    my head probably Sapiens" onto the map → import retries once, that exact string is now a
    prompt calibration example, and the structural fix is that **unverified liked-book seeds
    are dropped entirely** (taste echoes we can't verify are noise; explicit suggestions still
    keep the verify badge); (2) Google Books often omits `pageCount` on the best-matched
    volume → borrow it from another edition of the same work (the median-of-editions
    philosophy already used for OL); (3) OL's cover CDN throttles a 25-cover burst and one
    failed load was permanent → covers retry once after a pause before falling back to the
    placeholder; (4) the public page's gate button reads "Show data", not "unlock".
  - **Pace honesty:** skipping a member already dropped their tastes and named constraints, but
    their reading budget still shaped the pace graph and the suggested pages/fortnight — a slow
    reader sitting a round out kept capping the group. Stats now recompute over ACTIVE members
    only, and the field follows the suggestion only while it still IS the suggestion (a
    hand-edited pace is never overridden). Viewers get a pace pill of their own — sessions math
    is client-side, so each person checks the commitment at their own speed without touching
    what's published. Native number spinners hidden (typing is the real input here).
  - **Length discount in the quality blend** (see Tuning constants): 500 pages costs half a
    point, 800+ a full point, unknown pages stay unpenalized — enough to break ties toward
    books the group will finish, small enough that a strong long book still wins. One formula
    in `shared/quality.ts` keeps selection, rank badges, and the help text in agreement.
  - **Rank badges made legible:** a legend pill under the fit button shows a sample badge with
    "= best match" (the meaning previously lived only in the "?" popover; `pointer-events:none`
    so it never blocks a pan); badges paint one layer above cluster labels; and each badge picks
    the nearest of its cover's four corners that no label box intersects (same width estimate
    the label relaxation uses, computed once per layout) — titles keep painting over cover art,
    numbers stay off the letters entirely.
  - **Selections tray restored for viewers, cap 10.** Removing the ballot machinery (M27)
    over-corrected: the main link lost the ability to gather books for inspection at all. The
    tray is back for everyone — Select from the detail rail, reorder, flip through Present — as
    pure client-side state, no submissions; only running and publishing stay gated. `TRAY_CAP`
    5→10 for in-room shortlisting.
  - **Public-mirror prep:** test fixtures got consistent fictional names (the book lists stay —
    they're load-bearing parser cases), these notes describe members by role, and the app is
    retitled **"Was lesen?"**. This public repo is that mirror: it starts from a single fresh
    commit, because a scrub of the working tree can't reach names already written into earlier
    commits. The original development history stays private. `*.json` is gitignored (minus the
    package/tsconfig files) so a downloaded run file can't be committed by accident.

## Operating the live app

Run in production on Render's free plan via the `render.yaml` blueprint (docker, health check,
TRUST_PROXY; env values with colons must be quoted — Render's YAML parser rejects the unquoted
user-agent). Setup instructions live in [SETUP.md](../SETUP.md); this section is the operational
gotchas you only learn by running it. Koyeb, the original target, is dead: Mistral's Feb-2026
acquisition closed new free-tier signups.

- **A push to `main` auto-redeploys, and a redeploy CLEARS the published run** — the single
  published slot lives on the ephemeral disk (`~/.cache/satisfying-books/published-run.json`),
  so restarting the container loses the map the group is currently looking at. `render.yaml` sets
  no `autoDeploy: false`, so this is the default on every push.
  - For a **docs-only or otherwise non-deployable commit**, put `[skip render]` in the commit
    message — Render skips the auto-deploy and the published run survives untouched.
  - Before a commit that DOES need deploying, back the map up first:
    `curl -s https://<your-app>.onrender.com/api/current > backup.json` and keep it OUTSIDE the
    repo. The redacted payload validates as a SavedRun (`validateSavedRun` only requires
    `input.pace`), so it re-publishes cleanly: unlock → load run → publish.
- Sleeps after ~15 min idle (first visitor waits ~30–60s). **Keep-alive: a free UptimeRobot
  monitor pinging `/api/health` every 5 min holds it awake permanently** — one always-on service
  fits Render's 750 instance-hours/month (a full month is ~730h).
- **HALT check:** `APP_PASSPHRASE` must be set in the host's env, or the deployed app is fully
  open — anyone with the URL could start runs against your Anthropic key.
- `/api/current` is deliberately ungated so visitors can see the map, so it is REDACTED to what
  the viewer UI renders. If you add a field to `SavedRun`, decide whether it belongs in
  `handleCurrent`'s allowlist — the default of forwarding it is the wrong one.

## Deferred / later
- **Corpus-embedding candidate hints:** embed member tastes over a curated book corpus
  (e.g. the Goodreads UCSD dataset; hnbooks' own ~1k list is too small/HN-skewed) and inject
  each member's top-k nearest unread books into the Stage-1 lens prompts as hints Claude
  filters — recall-side only, never distances into scoring (double-counts topical similarity;
  embeddings can't judge quality/discussability). ~1–2 days + a few hundred MB index; revisit
  if, after 2–3 real cycles of feedback, picks feel samey.
- **Bring-your-own book lists as a candidate source:** let the group paste/drop any book list
  (the hnbooks list, an award list, a "best of 2025" article) and use it as a candidate-hint
  pool for Stage 1 (and later as the retrieval corpus above) — cheap, curated recall without
  building a corpus.
- Data-URI cover embedding for truly-offline saves; full drag-and-drop; access passphrase (if a
  public deployment sees token abuse); ESLint (strict `tsc` covers most for now); dropped-books
  rescue UI.
