import type { PastReadRow } from "@sb/shared";
import { errorMessage } from "./api";

// Client side of the past-reads store. The store lives on the organizer's laptop; this is the
// panel's API plus the one conversion the client needs (feedback CSV → store rows).

async function call(method: string, path: string, body?: unknown): Promise<PastReadRow[]> {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  const { rows } = (await res.json()) as { rows: PastReadRow[] };
  return Array.isArray(rows) ? rows : [];
}

export const fetchPastReads = (): Promise<PastReadRow[]> => call("GET", "/api/past-reads");
export const savePastReads = (rows: Partial<PastReadRow>[]): Promise<PastReadRow[]> =>
  call("POST", "/api/past-reads", { rows });
export const deletePastRead = (title: string): Promise<PastReadRow[]> =>
  call("DELETE", `/api/past-reads?title=${encodeURIComponent(title)}`);


