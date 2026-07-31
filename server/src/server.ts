import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import compression from "compression";
import express from "express";
import { config } from "./config";
import { handleHealth } from "./routes/health";
import { handleNormalize } from "./routes/normalize";
import { handlePreview } from "./routes/preview";
import { handleResolve } from "./routes/resolve";
import { handleRun } from "./routes/run";
import { handleAuthCheck, handleCurrent, handlePublish } from "./routes/publish";
import { constantTimeEqual, isOpenApiPath } from "./domain/auth";
import { checkRateLimit } from "./ratelimit/rateLimiter";

const app = express();
// Express semantics trap: a NUMBER is a hop count, a STRING is a trusted-address list — the
// env's "1" as a string makes req.ip the proxy's own address, collapsing every per-IP rate
// bucket into one shared global one. Coerce numeric strings (and "true") to their real types.
if (config.TRUST_PROXY) {
  const tp = config.TRUST_PROXY;
  app.set("trust proxy", /^\d+$/.test(tp) ? Number(tp) : tp === "true" ? true : tp);
}
// Compress responses, but never the SSE stream (compression buffers it and breaks streaming).
app.use(compression({ filter: (req, res) => (req.path === "/api/run" ? false : compression.filter(req, res)) }));
app.use(express.json({ limit: "512kb" }));

// App passphrase gate: with APP_PASSPHRASE set, every /api call except the open viewer paths
// needs the organizer's passphrase header. Failed attempts get their own bucket so the
// passphrase can't be brute-forced through the open door.
app.use((req, res, next) => {
  if (!config.APP_PASSPHRASE || !req.path.startsWith("/api") || isOpenApiPath(req.path)) return next();
  if (constantTimeEqual(req.get("x-app-passphrase"), config.APP_PASSPHRASE)) return next();
  const rl = checkRateLimit(`auth:${req.ip ?? "unknown"}`, 20);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retryAfter));
    res.status(429).json({ error: `Too many attempts — try again in ${rl.retryAfter}s.` });
    return;
  }
  res.status(401).json({ error: "Locked — unlock with the organizer passphrase." });
});

// API routes (registered before the SPA fallback so /api/* is never swallowed).
app.get("/api/health", handleHealth);
app.post("/api/run/preview", handlePreview);
app.post("/api/normalize", handleNormalize);
app.post("/api/resolve", handleResolve);
app.post("/api/run", handleRun);
// The published run: the main page shows it to everyone; publishing replaces it.
app.get("/api/current", handleCurrent);
app.post("/api/publish", handlePublish);
app.get("/api/auth-check", handleAuthCheck);

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
      `(model=${config.ANTHROPIC_MODEL}, effort=${config.ANTHROPIC_EFFORT})`,
  );
});
