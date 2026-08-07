import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import compression from "compression";
import express from "express";
import { config } from "./config";
import { handleHealth } from "./routes/health";
import { handleNormalize } from "./routes/normalize";
import { handleDeletePastRead, handleListPastReads, handleSavePastReads } from "./routes/pastReads";
import { handlePreview } from "./routes/preview";
import { handleResolve } from "./routes/resolve";
import { handleRun } from "./routes/run";
import { handleSuggestCheck, handleSuggestRescore } from "./routes/suggest";
import { handleCurrent, handlePublish } from "./routes/publish";
import { claudeAvailable } from "./claude/available";
import { isSsePath } from "./sse/channel";

const app = express();
// Express semantics trap: a NUMBER is a hop count, a STRING is a trusted-address list — the
// env's "1" as a string makes req.ip the proxy's own address, collapsing every per-IP rate
// bucket into one shared global one. Coerce numeric strings (and "true") to their real types.
if (config.TRUST_PROXY) {
  const tp = config.TRUST_PROXY;
  app.set("trust proxy", /^\d+$/.test(tp) ? Number(tp) : tp === "true" ? true : tp);
}
// Compress responses, but never an SSE stream (compression buffers it and breaks streaming).
// The exclusion is a LIST (`sse/channel.ts`), not one hardcoded path — /api/run was the only
// stream until M35 added /api/normalize, and a missed entry degrades silently.
app.use(compression({ filter: (req, res) => (isSsePath(req.path) ? false : compression.filter(req, res)) }));
app.use(express.json({ limit: "512kb" }));

// API routes (registered before the SPA fallback so /api/* is never swallowed).
//
// There is no passphrase gate. Instead the two roles are separated by what the machine can
// actually DO: Claude runs only through the local `claude` login, so a HOST cannot run the
// pipeline, and every organizer route below is simply NOT REGISTERED there. That is stronger
// than a gate and needs no secret at all — the endpoints don't exist rather than being guarded.
// A host still accepts a publish (that is how the map gets there), open and rate-limited: the
// deployment is meant to need zero configuration.
app.get("/api/health", handleHealth);
// The published run: the main page shows it to everyone; publishing replaces it.
app.get("/api/current", handleCurrent);
app.post("/api/publish", handlePublish);

if (claudeAvailable()) {
  app.post("/api/run/preview", handlePreview);
  app.post("/api/normalize", handleNormalize);
  app.post("/api/resolve", handleResolve);
  app.post("/api/run", handleRun);
  // Adding books is two steps: a cheap catalog check per title, then one scoring pass over the
  // whole pool (see pipeline/suggest).
  app.post("/api/suggest/check", handleSuggestCheck);
  app.post("/api/suggest/rescore", handleSuggestRescore);
  // The group's reading history — laptop-local by nature: a host's copy would sit on an
  // ephemeral disk that no run ever reads.
  app.get("/api/past-reads", handleListPastReads);
  app.post("/api/past-reads", handleSavePastReads);
  app.delete("/api/past-reads", handleDeletePastRead);
}

// In production, serve the built client from this same process. In dev this directory
// doesn't exist and Vite serves the client instead (proxying /api here).
const here = dirname(fileURLToPath(import.meta.url)); // server/src
const clientDist = resolve(here, "../../client/dist");
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api(\/|$)).*/, (_req, res) => res.sendFile(resolve(clientDist, "index.html")));
}

app.listen(config.PORT, () => {
  console.log(
    `[satisfying-books] listening on http://localhost:${config.PORT} ` +
      `(${claudeAvailable() ? `organizer: model=${config.ANTHROPIC_MODEL}, effort=${config.ANTHROPIC_EFFORT}` : "viewer only: no `claude` login, serves and publishes"})`,
  );
});
