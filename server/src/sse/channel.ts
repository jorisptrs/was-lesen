import type { Request, Response } from "express";
import type { SseEvent } from "@sb/shared";

export interface Sse {
  send: (event: SseEvent) => void;
  close: () => void;
}

/**
 * Open a Server-Sent Events stream on `res`. Each event is written as an
 * `event: <type>` / `data: <json>` frame. A 15s heartbeat comment keeps the connection
 * alive. Buffering is disabled (`X-Accel-Buffering: no`, `no-transform`); the route must
 * also be excluded from any response compression (added in M8).
 */
export function openSse(_req: Request, res: Response): Sse {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(": ping\n\n");
  }, 15_000);

  const send = (event: SseEvent) => {
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
