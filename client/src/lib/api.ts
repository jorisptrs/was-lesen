import { type SavedRun, validateSavedRun } from "@sb/shared";

// The organizer gate + published-run API. With APP_PASSPHRASE set server-side, every call
// except health/current needs the passphrase header; visitors browse the published map only.

const PASS_KEY = "sb:passphrase";

export function loadPassphrase(): string {
  try {
    return localStorage.getItem(PASS_KEY) ?? "";
  } catch {
    return "";
  }
}

export function savePassphrase(pw: string): void {
  try {
    if (pw) localStorage.setItem(PASS_KEY, pw);
    else localStorage.removeItem(PASS_KEY);
  } catch {
    // private mode — the unlock just won't survive a reload
  }
}

/** Header for gated calls. Harmless when the gate is off (server ignores it). */
export function authHeaders(): Record<string, string> {
  const pw = loadPassphrase();
  return pw ? { "X-App-Passphrase": pw } : {};
}

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

/** 200 = this browser can organize (valid passphrase, or the gate is off). */
export async function checkUnlocked(pw?: string): Promise<boolean> {
  const headers = pw ? { "X-App-Passphrase": pw } : authHeaders();
  const res = await fetch("/api/auth-check", { headers });
  return res.ok;
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
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ run }),
  });
  return jsonOrThrow<{ publishedTo?: string }>(res);
}
