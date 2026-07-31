// Book-title casing for member-typed strings ("moral ambition" → "Moral Ambition").
// Conservative: words that already contain an uppercase letter (proper casing, acronyms,
// "iPhone") are left untouched — only all-lowercase words are adjusted.

const SMALL = new Set([
  "a", "an", "the", "and", "or", "nor", "but", "of", "in", "on", "at", "to", "for", "from",
  "by", "with", "as", "vs",
]);

export function titleCase(title: string): string {
  const words = title.split(" ");
  const last = words.length - 1;
  let afterBreak = true; // capitalize after a colon/dash as well as at the start
  return words
    .map((w, i) => {
      const isBreak = /[:—–-]$/.test(w);
      const bare = w.toLowerCase().replace(/[^a-z']/g, "");
      let out = w;
      if (w === w.toLowerCase() && /[a-z]/.test(w)) {
        const small = SMALL.has(bare) && i !== 0 && i !== last && !afterBreak;
        out = small ? w : w.charAt(0).toUpperCase() + w.slice(1);
      }
      afterBreak = isBreak;
      return out;
    })
    .join(" ");
}
