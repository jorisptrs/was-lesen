// The file protocol: the CLI writes its answer as JSONL into a scratch sandbox instead of
// returning it as response text. The CLI caps output at ~4096 tokens PER RESPONSE and honours no
// override, but it is an agent with a multi-turn loop — asked to append lines to a file it takes
// as many turns as the work needs. Everything here is pure so it can be tested without spawning
// the CLI; the process side lives in `client.ts`.

/** Grouped-append wording only helps once a call is big enough to need several turns. */
export const GROUP_WORDING_MIN = 13;
/** Above this, ask for a skim first — early lines otherwise get calibrated against nothing. */
export const SKIM_MIN = 25;
export const GROUP_SIZE = 8;

const FLOOR_MS = 10 * 60_000;
const PER_LINE_MS = 15_000;
const CAP_MS = 30 * 60_000;

export interface JsonlParse<T> {
  valid: T[];
  /** Raw text of lines that were not JSON, or failed `parseLine`. Truncated, for logs. */
  malformed: string[];
}

/** How many physical lines one logical object may span before we give up joining it. */
const MAX_JOIN_LINES = 16;

/**
 * Escape raw control characters inside JSON string literals. Models write two-paragraph summaries
 * with REAL newlines, which both breaks one-object-per-line and makes `JSON.parse` reject the
 * result ("Bad control character"). Only used on the repair path.
 */
function escapeControlCharsInStrings(json: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (const c of json) {
    if (esc) {
      out += c;
      esc = false;
      continue;
    }
    if (c === "\\") {
      out += c;
      if (inStr) esc = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      out += c;
      continue;
    }
    if (inStr && c.charCodeAt(0) < 0x20) {
      out +=
        c === "\n" ? "\\n" : c === "\r" ? "\\r" : c === "\t" ? "\\t" : `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
      continue;
    }
    out += c;
  }
  return out;
}

type LineAttempt<T> = { kind: "ok"; value: T } | { kind: "json" } | { kind: "schema" };

function attempt<T>(raw: string, parseLine: (raw: unknown) => T): LineAttempt<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Syntax error only — the text may be an object split across several physical lines.
    return { kind: "json" };
  }
  try {
    return { kind: "ok", value: parseLine(parsed) };
  } catch {
    // Well-formed JSON that isn't the shape we asked for. Joining more lines cannot fix that.
    return { kind: "schema" };
  }
}

/**
 * Parse newline-terminated JSON objects. A trailing unterminated line is IGNORED: the process may
 * have been killed mid-write, and half a line is not a result. Everything complete still counts —
 * salvaging a truncated run is the whole point of writing to a file.
 *
 * Repairs objects the model spread over several lines (a summary written with real paragraph
 * breaks) by joining forward until it parses. Only a JSON *syntax* error triggers joining, so a
 * schema-rejected line can never swallow the good line after it.
 */
export function parseJsonl<T>(text: string, parseLine: (raw: unknown) => T): JsonlParse<T> {
  const valid: T[] = [];
  const malformed: string[] = [];
  // Dropping the segment after the last "\n" is what makes the tail rule work: a fully written
  // file ends with "\n", so its last segment is "" and nothing is lost.
  const lines = text.split("\n").slice(0, -1);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;

    const first = attempt(line.trim(), parseLine);
    if (first.kind === "ok") {
      valid.push(first.value);
      continue;
    }
    if (first.kind === "schema") {
      malformed.push(line.trim().slice(0, 200));
      continue;
    }

    // Syntax error: try gluing the following lines on, escaping the control characters the join
    // reintroduces, until it parses or we run out of patience.
    let joined = line;
    let repaired = false;
    for (let k = 1; k < MAX_JOIN_LINES && i + k < lines.length; k++) {
      joined += `\n${lines[i + k]!}`;
      const next = attempt(escapeControlCharsInStrings(joined.trim()), parseLine);
      if (next.kind === "ok") {
        valid.push(next.value);
        i += k;
        repaired = true;
        break;
      }
      if (next.kind === "schema") {
        malformed.push(joined.trim().slice(0, 200));
        i += k;
        repaired = true;
        break;
      }
    }
    // Nothing parsed: drop only THIS line and let the next one start fresh.
    if (!repaired) malformed.push(line.trim().slice(0, 200));
  }
  return { valid, malformed };
}

/** Complete lines only — the cheap progress metric, deliberately without JSON parsing. */
export function countCompleteLines(text: string): number {
  let n = 0;
  const lines = text.split("\n").slice(0, -1);
  for (const line of lines) if (line.trim()) n++;
  return n;
}

/**
 * Index lines by key, LAST-wins: a repeated key means the model corrected itself, and it makes
 * merging a follow-up call's output a plain overwrite. First-seen insertion order is preserved.
 */
export function mergeByKey<T>(lines: T[], keyOf: (line: T) => string): Map<string, T> {
  const merged = new Map<string, T>();
  for (const line of lines) merged.set(keyOf(line), line);
  return merged;
}

export function missingKeys(expected: string[], seen: ReadonlySet<string>): string[] {
  return expected.filter((k) => !seen.has(k));
}

export interface FileProtocolOptions {
  /**
   * ABSOLUTE path of the output file. Verified on CLI 2.1.218: a relative path is resolved
   * against the home directory, NOT the child process's cwd, so it lands outside the sandbox and
   * is denied. The sandbox is granted separately with --add-dir.
   */
  outputPath: string;
  /** JSON Schema for ONE line, inlined into the prompt. */
  lineSchema: Record<string, unknown>;
  /** Drives grouping wording, the skim nudge, and the timeout. */
  expectedLines?: number;
  /** Writing nothing is a legitimate answer (the rule filter finding no violations). */
  zeroLinesOk?: boolean;
}

/**
 * The single place the transport is described to the model. Stage prompts describe what a line
 * MEANS; this describes how to deliver it, so the two never drift apart.
 */
export function buildFileProtocolBlock(opts: FileProtocolOptions): string {
  const parts = [
    "Output (MANDATORY): do NOT put your answer in your reply. Append your results to this " +
      `scratch file, using its full path exactly as written:\n${opts.outputPath}\n` +
      "Use the file tools: exactly ONE JSON object per line, each line validating against this " +
      "JSON Schema:",
    JSON.stringify(opts.lineSchema),
    // Observed on a real 67-book run: two-paragraph summaries got written with real paragraph
    // breaks, splitting single objects across lines. The parser repairs it; saying so is cheaper.
    "Each object must sit on ONE physical line — never pretty-print across lines, and write any " +
      "line break inside a string as \\n rather than a real newline.",
  ];
  const expected = opts.expectedLines ?? 0;
  if (expected >= SKIM_MIN) {
    parts.push(
      `Before writing the first group, skim the whole list once so early lines are calibrated ` +
        `against late ones.`,
    );
  }
  parts.push(
    expected >= GROUP_WORDING_MIN
      ? `Work in groups of ~${GROUP_SIZE} lines: append a group, then continue with the next. ` +
          `Take as many turns as you need — do not compress or shorten later lines to finish sooner.`
      : "Write all the lines, then finish.",
  );
  if (opts.zeroLinesOk) {
    parts.push("If there is nothing to report, write no lines — an empty or absent file is a valid result.");
  }
  parts.push("When every line is written, reply with exactly: done");
  return parts.join("\n");
}

/**
 * Wall-clock budget for one call. This is the ONLY runaway guard: the CLI has no --max-turns, so
 * a confused agent would otherwise loop until the process is killed by something else.
 */
export function callTimeoutMs(expectedLines?: number): number {
  return Math.min(CAP_MS, Math.max(FLOOR_MS, (expectedLines ?? 0) * PER_LINE_MS));
}
