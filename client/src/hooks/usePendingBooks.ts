import { useMemo, useRef, useState } from "react";
import type { PastRead, PendingBook, RunQuality, RunRequest, ScoredState } from "@sb/shared";
import { serialQueue } from "../lib/serialQueue";
import { type RescoreOutcome, checkBook, rescoreBooks } from "../lib/suggest";

/** Everything the calls need from the app, re-read on every render so nothing runs on stale
 * inputs. */
export interface SuggestContext {
  scored: ScoredState | null;
  members: { name: string }[];
  body: RunRequest;
  quality: RunQuality;
  history: PastRead[];
}

export interface UsePendingBooks {
  /** Look a title up and, if it's real and new, park it for the next rescore. */
  add: (title: string, author: string, nominatedBy: string | null) => void;
  remove: (id: string) => void;
  /** Score the whole pool — map + pending. */
  rescore: () => void;
  reset: () => void;
  pending: PendingBook[];
  /** A lookup is in flight (or queued). */
  checking: boolean;
  /** The scoring pass is running. */
  scoring: boolean;
  status: string | null;
}

/**
 * Books are collected first and scored once.
 *
 * Lookups are cheap and queued serially (so two titles can't both be checked against a pending
 * list that neither has landed in yet). Scoring is the expensive part and happens on demand over
 * EVERYTHING — that is what makes the new books' fits comparable to the old ones' instead of a
 * guess against a handful of quoted examples.
 */
export function usePendingBooks(opts: {
  ctx: SuggestContext;
  /** Apply a finished rescore (load the map, remap the tray). Any string returned is appended
   * to the status line. */
  apply: (outcome: RescoreOutcome) => string | void;
}): UsePendingBooks {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const [pending, setPending] = useState<PendingBook[]>([]);
  const [checking, setChecking] = useState(false);
  const [scoring, setScoring] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // Read inside the queue, which outlives the render that enqueued the work.
  const pendingRef = useRef<PendingBook[]>([]);
  const scoringRef = useRef(false);

  const setBoth = (next: PendingBook[]) => {
    pendingRef.current = next;
    setPending(next);
  };

  const lookups = useMemo(
    () =>
      serialQueue<{ title: string; author: string; nominatedBy: string | null }>({
        onBusyChange: setChecking,
        run: async (item, isCurrent) => {
          const { ctx } = optsRef.current;
          if (!ctx.scored) return;
          setStatus(`looking up "${item.title}"…`);
          try {
            const book = await checkBook({
              title: item.title,
              author: item.author,
              nominatedBy: item.nominatedBy,
              membersText: ctx.body.membersText,
              ...(ctx.history.length ? { history: ctx.history } : {}),
              books: ctx.scored.books,
              pendingTitles: pendingRef.current.map((b) => b.title),
            });
            if (!isCurrent()) return;
            setBoth([...pendingRef.current, book]);
            setStatus(`${book.title}${book.author ? ` — ${book.author}` : ""} ready to score.`);
          } catch (e) {
            // One bad title must not strand the rest of the queue.
            if (!isCurrent()) return;
            setStatus(e instanceof Error ? e.message : "Could not look that book up.");
          }
        },
      }),
    [],
  );

  const rescore = async () => {
    const { ctx, apply } = optsRef.current;
    if (scoringRef.current || !ctx.scored || pendingRef.current.length === 0) return;
    scoringRef.current = true;
    setScoring(true);
    const batch = pendingRef.current;
    try {
      const outcome = await rescoreBooks(
        {
          books: ctx.scored.books,
          clusters: ctx.scored.clusters,
          pending: batch,
          membersText: ctx.body.membersText,
          constraints: ctx.body.constraints,
          quality: ctx.quality,
          ...(ctx.history.length ? { history: ctx.history } : {}),
        },
        setStatus,
      );
      // Only clear what we actually sent — anything typed while it ran stays queued for next.
      const sent = new Set(batch.map((b) => b.id));
      setBoth(pendingRef.current.filter((b) => !sent.has(b.id)));
      const note = optsRef.current.apply(outcome);
      setStatus(`${outcome.message}${note ? ` ${note}` : ""}`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Could not rescore.");
    } finally {
      scoringRef.current = false;
      setScoring(false);
    }
  };

  return {
    pending,
    checking,
    scoring,
    status,
    add: (title, author, nominatedBy) => {
      const { ctx } = optsRef.current;
      if (!ctx.scored) return;
      lookups.push({ title, author, nominatedBy });
    },
    remove: (id) => setBoth(pendingRef.current.filter((b) => b.id !== id)),
    rescore: () => void rescore(),
    reset: () => {
      lookups.reset();
      setBoth([]);
      setStatus(null);
    },
  };
}
