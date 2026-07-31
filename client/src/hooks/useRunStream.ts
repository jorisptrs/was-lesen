import { useCallback, useReducer, useRef } from "react";
import type { RunRequest, SseEvent } from "@sb/shared";
import { authHeaders, errorMessage } from "../lib/api";
import { initialRunState, runReducer } from "../state";
import type { ScoredState } from "../state";

/** Pull complete SSE frames out of a rolling buffer; return parsed events + the remainder. */
function drainFrames(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  let sep = buffer.indexOf("\n\n");
  while (sep !== -1) {
    const frame = buffer.slice(0, sep);
    buffer = buffer.slice(sep + 2);
    for (const line of frame.split("\n")) {
      if (line.startsWith("data:")) {
        const json = line.slice(5).trim();
        if (json) {
          try {
            events.push(JSON.parse(json) as SseEvent);
          } catch {
            // ignore a malformed frame rather than break the stream
          }
        }
      }
    }
    sep = buffer.indexOf("\n\n");
  }
  return { events, rest: buffer };
}

export function useRunStream() {
  const [state, dispatch] = useReducer(runReducer, initialRunState);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(async (body: RunRequest) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    dispatch({ type: "start" });

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        dispatch({ type: "stream_error", message: await errorMessage(res) });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = drainFrames(buffer);
        buffer = rest;
        for (const event of events) dispatch({ type: "sse", event });
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      dispatch({ type: "stream_error", message: err instanceof Error ? err.message : "Stream failed" });
    }
  }, []);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  /** Render a saved run offline — no network, no reducer stream. */
  const loadRun = useCallback((members: { name: string }[], scored: ScoredState) => {
    abortRef.current?.abort();
    dispatch({ type: "load", members, scored });
  }, []);

  return { state, start, cancel, loadRun };
}
