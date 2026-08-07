import { useCallback, useReducer, useRef } from "react";
import type { RunRequest, SseEvent } from "@sb/shared";
import { postSseStream } from "../lib/sse";
import { initialRunState, runReducer } from "../state";
import type { ScoredState } from "../state";

export function useRunStream() {
  const [state, dispatch] = useReducer(runReducer, initialRunState);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(async (body: RunRequest) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    dispatch({ type: "start" });

    try {
      await postSseStream<SseEvent>("/api/run", body, (event) => dispatch({ type: "sse", event }), controller.signal);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      dispatch({ type: "stream_error", message: err instanceof Error ? err.message : "Stream failed" });
    }
  }, []);

  // Cancel = abort AND go back to idle, synchronously. The abort alone surfaces in start()'s
  // catch as an AbortError, which returns without dispatching — so nothing ever moved status
  // off "running": the spinner and the Cancel button just stayed (the "cancel doesn't work"
  // symptom). The reset must NOT live in that catch: start() aborts the previous run too, and
  // its old promise settles AFTER the new run dispatches "start" — a reset there would wipe
  // the fresh run's state.
  const cancel = useCallback(() => {
    abortRef.current?.abort();
    dispatch({ type: "reset" });
  }, []);

  /** Render a saved run offline — no network, no reducer stream. */
  const loadRun = useCallback((members: { name: string }[], scored: ScoredState) => {
    abortRef.current?.abort();
    dispatch({ type: "load", members, scored });
  }, []);

  return { state, start, cancel, loadRun };
}
