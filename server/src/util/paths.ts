import { homedir } from "node:os";
import { join } from "node:path";

/** Everything this app persists lives in one directory, outside the repo. It holds member-facing
 * data (a published run, the group's past reads), which is exactly why it is not in the repo. */
export const CACHE_DIR = join(homedir(), ".cache", "satisfying-books");

export const cacheFile = (name: string): string => join(CACHE_DIR, name);
