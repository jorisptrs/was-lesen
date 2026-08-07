# Was lesen?

A book-club companion ("What to read?").

A tool for a ~10-person reading group. Members paste short "what I want to read"
paragraphs (plus books they'd suggest, have already read, or have loved); **Claude
nominates** a set of real, verified books; the group browses them on a projector as a
**cover map** (cover size = match score, color = cluster), pulls up to **3 finalists** into
a tray, advocates, and votes by hand-raise in the room. Claude nominates; humans decide.
Also usable solo at home.

Nothing is persisted server-side — you bring your data in each run (paste, or load a saved
JSON), and the group decides live. Every title is verified against a books API before it can
appear, so a missing cover doubles as a hallucination smell test.

## Stack

- **client/** — Vite + React + TypeScript single-page app.
- **server/** — Node + Express (TypeScript). Proxies the Anthropic + books APIs, streams
  pipeline progress over SSE, and serves the built client in production.
- **shared/** — TypeScript types shared by both (`@sb/shared`).

One long-running process serves both the SPA and `/api`. See `docs/NOTES.md` for
architecture, decisions, and milestone status.

## Develop

```bash
npm install
cp .env.example .env   # no keys needed — Claude runs through your logged-in `claude` CLI
npm run dev            # server on :3000, client (Vite) on :5173 proxying /api → :3000
```

Open http://localhost:5173.

## Other commands

```bash
npm run typecheck   # tsc --noEmit across workspaces
npm test            # vitest
npm run build       # build the client
npm start           # run the server (serves the built client if present)
```

## Deploy

One long-running process serves the built SPA and `/api` on a single port:

```bash
npm run build && npm start        # serves everything on $PORT (default 3000)
```

Or with Docker:

```bash
docker build -t satisfying-books .
docker run --env-file .env -p 3000:3000 satisfying-books
```

For a hosted deployment set `TRUST_PROXY` so the per-IP rate limit sees real client IPs. The
in-memory rate limit assumes a single instance (not serverless).

**Claude runs on your subscription, never on API credits.** There is no `ANTHROPIC_API_KEY`:
the server shells out to your logged-in [`claude` CLI](https://docs.claude.com/en/docs/claude-code/overview),
so a run costs nothing beyond your Claude Pro/Max plan. The trade-off is deliberate — the
pipeline only runs on a machine with a CLI login, so a hosted copy serves and publishes but
cannot compute. The workflow: run locally → save the JSON → open the hosted app → unlock →
load run → publish.

The book map is positioned semantically by **embeddings**. By default `EMBEDDINGS_PROVIDER=local`
runs a small model in-process (no key, no per-run cost, offline; adds onnxruntime to the image and
downloads ~30 MB on first use). Set `EMBEDDINGS_PROVIDER=none` for a lighter image with a
deterministic layout instead, or `voyage`/`openai` with `EMBEDDINGS_API_KEY` to use a hosted
embedder. Embeddings are best-effort — any failure falls back to the deterministic layout.

## Deploy for free

The repo ships a `render.yaml` blueprint for [Render](https://render.com)'s free plan (verified
July 2026: 512 MB / 0.1 CPU, no card, 750 h/month; sleeps after 15 min idle, ~1 min wake;
ephemeral filesystem — the book-match cache resets on sleep, which is fine, it's best-effort):

1. Render dashboard → **New → Blueprint** → pick this repo.
2. Set `GOOGLE_BOOKS_API_KEY` when prompted (optional, but it fills covers and page counts).
3. The app serves at `https://<name>.onrender.com`.

Note the 0.1 CPU: local embeddings run slow there — if runs crawl or the instance OOMs, set
`EMBEDDINGS_PROVIDER=none` (deterministic layout) or use a hosted embedder.

Tip: a free [UptimeRobot](https://uptimerobot.com) monitor pinging `/api/health` every 5 min
keeps the instance awake permanently (one always-on service fits the 750 h/month), so the
published map stays up instead of vanishing at the first 15-min idle gap.

Alternatives, verified July 2026:
- ~~Koyeb free~~ — gone: Mistral's acquisition (Feb 2026) closed new Starter-tier signups.
- **Oracle Cloud Always Free** — halved in June 2026 to 2 OCPU / 12 GB ARM, still the roomiest
  truly-free always-on option, but provisioning hits "out of capacity" in most regions
  (Frankfurt and Singapore usually work) and the VM is self-managed.
- **Google Cloud Run** — real never-expiring free quota, scale-to-zero; needs a card on file.
- **Fly.io / Railway** — no genuine free tier anymore (Fly: card + ~$2+/mo; Railway: one-time
  $5 trial then $1/mo credit).

There is no passphrase to set. A deployed host has no `claude` login, so it cannot run the
pipeline — the run/import/suggest routes are **not registered there at all**, and visitors get
the read-only map. You run on your laptop and publish with one click.

There are no passwords to set anywhere. Publishing to the host is open — the deployment needs
no configuration at all, and if someone ever replaced the map you republish in one click.

## Requirements

Node ≥ 20 (developed on Node 24).
