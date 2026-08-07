import { errorMessage } from "./api";

// One SSE reader for every streaming route (the run, Stage-0 normalize). `fetch` + a
// ReadableStream rather than `EventSource`, because these streams answer a POST and need the
// passphrase header — neither of which EventSource can do.

/**
 * Pull complete SSE frames out of a rolling buffer; return parsed events + the remainder.
 * Pure, so it can be tested against split-mid-frame chunks — the failure mode that only shows
 * up on a slow network. Heartbeat comments (`: ping`) and malformed JSON are skipped rather
 * than allowed to break the stream.
 */
export function drainFrames<E>(buffer: string): { events: E[]; rest: string } {
  const events: E[] = [];
  let sep = buffer.indexOf("\n\n");
  while (sep !== -1) {
    const frame = buffer.slice(0, sep);
    buffer = buffer.slice(sep + 2);
    for (const line of frame.split("\n")) {
      if (line.startsWith("data:")) {
        const json = line.slice(5).trim();
        if (json) {
          try {
            events.push(JSON.parse(json) as E);
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

/**
 * POST `body` and consume the SSE stream it answers with, calling `onEvent` per event. Resolves
 * when the server closes the stream; throws on a pre-stream HTTP error (the server does all
 * validation/rate-limiting before opening, so those stay ordinary statuses) or a mid-stream
 * network failure. An abort surfaces as the usual `AbortError`.
 *
 * Note for callers: a resolved promise means the STREAM ended, not that the work succeeded —
 * the terminal event carries that. Retrying on "resolved but no terminal event" is the correct
 * test; `res.ok` is not (it is true as soon as the headers land, before any work happens).
 */
export async function postSseStream<E>(
  url: string,
  body: unknown,
  onEvent: (event: E) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(await errorMessage(res));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = drainFrames<E>(buffer);
    buffer = rest;
    for (const event of events) onEvent(event);
  }
}
