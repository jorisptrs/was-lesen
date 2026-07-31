import { randomUUID } from "node:crypto";

export function shortId(prefix = ""): string {
  const id = randomUUID().replace(/-/g, "").slice(0, 8);
  return prefix ? `${prefix}_${id}` : id;
}
