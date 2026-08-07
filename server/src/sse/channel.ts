import type { Response } from "express";

export interface Sse<E> {
  send: (event: E) => void;
  close: () => void;
}

/**
 * Every route that answers with an SSE stream. `server.ts`'s compression middleware MUST skip
 * these: compression buffers the response, so a "streaming" route would deliver everything at
 * once when it ends. Adding an SSE route and forgetting this list is the silent failure mode —
 * the route still works, it just stops streaming. Kept next to `openSse` because that is what
 * an implementer of the next SSE route is reading.
 */
export const SSE_PATHS: ReadonlySet<string> = new Set(["/api/run", "/api/normalize", "/api/suggest/rescore"]);

/** Express is non-strict about trailing slashes, so `/api/run/` reaches the same handler and
 * must be excluded from compression too. */
export function isSsePath(path: string): boolean {
  return SSE_PATHS.has(path.length > 1 ? path.replace(/\/+$/, "") : path);
}

/**
 * Open a Server-Sent Events stream on `res`, typed to one route's event union. Each event is
 * written as an `event: <type>` / `data: <json>` frame. A 15s heartbeat comment keeps the
 * connection alive. Buffering is disabled (`X-Accel-Buffering: no`, `no-transform`).
 *
 * Deliberately takes only `res`: it never reads the request, which is what lets it stream a
 * response to a POST. Two rules for callers: do validation/rate-limiting BEFORE opening (once
 * the stream is open, an HTTP status is no longer available), and abort on `res` "close", never
 * `req` "close" — for a buffered POST body the latter fires as soon as the body is read.
 */
export function openSse<E extends { type: string }>(res: Response): Sse<E> {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(": ping\n\n");
  }, 15_000);

  const send = (event: E) => {
    if (res.writableEnded) return;
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const close = () => {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  };

  return { send, close };
}
