import { type SavedRun, validateSavedRun } from "@sb/shared";

// There is no passphrase. Which app you get is decided by what the SERVER can do: the
// organizer's laptop has a `claude` login and serves the run routes; a host doesn't and doesn't.
// See routes/health.ts — `canRun` is the whole of it.

export async function errorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (parsed.error) return parsed.error;
  } catch {
    // not JSON (e.g. express's own 413 body)
  }
  return text || `Request failed (${res.status})`;
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as T;
}

/** Can the server we're talking to run the pipeline? False → the read-only viewer. */
export async function fetchCanRun(): Promise<boolean> {
  const res = await fetch("/api/health");
  if (!res.ok) return false;
  const data = (await res.json().catch(() => ({}))) as { canRun?: boolean };
  return data.canRun === true;
}

/** The run the main page shows to everyone — null when nothing is published. */
export async function fetchCurrent(): Promise<SavedRun | null> {
  const res = await fetch("/api/current");
  if (res.status === 404) return null;
  const data = await jsonOrThrow<{ run: unknown }>(res);
  return validateSavedRun(data.run);
}

export async function publishRun(run: SavedRun): Promise<{ publishedTo?: string }> {
  const res = await fetch("/api/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ run }),
  });
  return jsonOrThrow<{ publishedTo?: string }>(res);
}
