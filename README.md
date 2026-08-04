# Was lesen?

A book-club companion. *("What to read?")*

Your reading group fills in a short form — a paragraph on what they feel like reading, books
they'd suggest, books they've already read, books they love. **Claude nominates** a set of real,
verified books. The group browses them together on a projector as a **cover map**, pulls
favourites into a tray, argues, and votes by hand-raise in the room.

**Claude nominates; humans decide.** The tool never picks the book. It does the part that's
tedious — reading eight paragraphs of taste, remembering who's already read what, finding books
that serve more than one person — and then gets out of the way.

<!-- A screenshot of the map goes well here. -->

## What makes it not-a-chatbot

- **Every title is verified against a real books API before it can appear.** Claude proposes;
  Open Library and Google Books decide what exists. A book the catalogs can't find gets a
  "needs verify" badge, and a missing cover doubles as a hallucination smell test. This is why
  a cheap model works well here — the verifier carries the quality, not the model.
- **The map is semantic.** Books are embedded, clustered on those embeddings, and positioned by
  projecting them to 2D — so related books sit near each other and each cluster gets a name.
  Nothing about the layout is hand-authored.
- **The maths is not an LLM.** Which books make the cut, the per-member fit spread, the rank
  badges — all pure, unit-tested server code. The model scores; the app decides, recountably.
- **Nothing is persisted server-side.** You bring your data in each run and the group decides
  live. One published map is stored so viewers have something to look at, and it's redacted to
  what the screen actually shows.

## Status: shared as-is

This was built for **one** book club — mine — over about thirty milestones, and it's still
shaped like that: it assumes one organizer, one group, one map at a time. It works, it's tested
(150 unit tests), and it's been used for real. But it's a personal project published as an
artifact, not a maintained product.

So, honestly: **no support, no roadmap, no promises.** Issues and PRs may sit. If it's useful to
you, fork it and make it yours — that's the best outcome I can offer. If you want to understand
*why* it's built the way it is (including the several things I built and then deleted),
[`docs/NOTES.md`](docs/NOTES.md) is the full decision record.

## Set it up

**→ [SETUP.md](SETUP.md)** walks through it end to end: API keys, one-click deploy, the intake
form, and running your first cycle. Budget about half an hour, most of it spent writing your
form questions.

The short version: install the [`claude` CLI](https://docs.claude.com/en/docs/claude-code/overview)
and log in, run the app locally, make a form, upload the CSV, hit run. Deploying to
[Render](https://render.com/) is optional and only needed if you want a link your group can open.

## Stack

- **client/** — Vite + React + TypeScript single-page app.
- **server/** — Node + Express (TypeScript). Proxies the Anthropic + books APIs, streams
  pipeline progress over SSE, and serves the built client in production.
- **shared/** — TypeScript types shared by both (`@sb/shared`).

One long-running process serves both the SPA and `/api`. A run goes: Stage 0 (normalize the
pasted titles) → Stage 1 (three parallel nomination passes: champions, bridges, wildcards) →
Stage 2 (verify against the books APIs) → a constraint filter → Stage 3 (per-member scoring) →
selection maths → embeddings, clustering, and 2D layout.

## Develop

```bash
npm install
cp .env.example .env   # no keys needed — Claude runs through your logged-in `claude` CLI
npm run dev            # server on :3000, client on :5173 proxying /api → :3000
```

Open http://localhost:5173.

```bash
npm run typecheck   # tsc --noEmit across workspaces
npm test            # vitest — 150 tests
npm run build       # build the client
npm start           # run the server (serves the built client if present)
```

No secrets are required: Claude is reached through your logged-in `claude` CLI, not an API key,
so a fresh clone runs the full suite with no configuration at all.

Requires Node ≥ 20 (developed on Node 24).

## Licence

MIT — see [LICENSE](LICENSE).
