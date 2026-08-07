// One CSV codec for the whole app: the Tally imports read with it (client) and the past-reads
// store is written with it (server). A store file a human can open in a spreadsheet is the
// point, so the writer has to quote properly rather than hope notes contain no commas.

/** RFC-4180-ish CSV parser: quoted fields, "" escapes, embedded newlines and commas. */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Quote a field only when it needs it — an unquoted file stays diff-friendly and readable. */
function csvField(value: string): string {
  return /[",\n\r]|^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Serialize rows (header included by the caller) with a trailing newline. */
export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvField).join(",")).join("\n") + "\n";
}
