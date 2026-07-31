import { timingSafeEqual } from "node:crypto";

/** Constant-time string compare that tolerates undefined and length mismatches. */
export function constantTimeEqual(provided: string | undefined, expected: string | undefined): boolean {
  if (!expected || typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** API paths that stay open when the app passphrase gate is on: viewers need the published
 * map and the health check must keep working for keep-alive pings. Everything else under
 * /api costs money or mutates state and is organizer-only. */
export function isOpenApiPath(path: string): boolean {
  return path === "/api/health" || path === "/api/current";
}
