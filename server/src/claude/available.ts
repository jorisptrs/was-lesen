import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

// Claude runs only through the logged-in `claude` CLI (M33), so a HOST cannot run the pipeline —
// it has no login and no binary. That was an accepted consequence, but the UI never said so: the
// deployed app still offered Run and the suggest bar, and pressing them failed with a raw
// "claude CLI not found on PATH". The client asks this instead and hides what can't work.
//
// Note the asymmetry that made this confusing: ADDING a book is only a books-catalog lookup and
// works fine on a host; only SCORING needs Claude. So the bar looked functional right up to the
// button that couldn't work.

let cached: boolean | null = null;

/** Is the `claude` binary on PATH? Resolved once — PATH doesn't change under a running server. */
export function claudeAvailable(): boolean {
  if (cached !== null) return cached;
  cached = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => {
      try {
        accessSync(join(dir, "claude"), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  if (!cached) {
    console.log("[claude] no `claude` binary on PATH — this instance serves and publishes only");
  }
  return cached;
}
