/** Deterministic hue (0–359) from a title, for the no-cover placeholder tile. */
export function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  return h % 360;
}
