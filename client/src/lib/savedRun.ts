import { type SavedRun, type ScoredState, validateSavedRun } from "@sb/shared";

export type { SavedRun };

export function buildSavedRun(args: {
  input: SavedRun["input"];
  members: { name: string }[];
  scored: ScoredState;
  model?: string;
}): SavedRun {
  return {
    app: "satisfying-books",
    version: 1,
    savedAt: new Date().toISOString(),
    ...(args.model ? { model: args.model } : {}),
    input: args.input,
    members: args.members,
    scored: args.scored,
  };
}

export function downloadRun(saved: SavedRun): void {
  const blob = new Blob([JSON.stringify(saved, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `satisfying-books-${saved.savedAt.slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Parse + validate a saved-run file. Throws a human-readable Error on any mismatch. */
export function parseSavedRun(text: string): SavedRun {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  return validateSavedRun(data);
}
