import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Effort } from "@sb/shared";
import { config } from "../config";
import {
  buildFileProtocolBlock,
  callTimeoutMs,
  countCompleteLines,
  mergeByKey,
  missingKeys,
  parseJsonl,
} from "./jsonl";

// Claude runs through the logged-in `claude` CLI ONLY — the organizer's own subscription. The
// pay-per-token API path was removed deliberately: this is a single-organizer tool run from a
// laptop, and a second billing path is a footgun (an accidental API key in the environment used
// to mean a run silently charged credits). Consequence, by design: a HOST cannot run the
// pipeline, because it has no CLI login. The hosted app only serves and publishes a map that was
// computed locally — which needs no Claude at all.

/** A pipeline-level error that maps cleanly onto an SSE `error` event. */
export class ClaudeError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable: boolean,
  ) {
    super(message);
    this.name = "ClaudeError";
  }
}

export interface StructuredCallInput<T> {
  system: string;
  user: string;
  effort: Effort;
  /** JSON Schema for ONE output line. */
  lineSchema: Record<string, unknown>;
  /** Validate one parsed line (e.g. a zod `schema.parse`). Throwing marks the line malformed. */
  parseLine: (raw: unknown) => T;
  /** Identity of a line, for de-duplication and gap detection. Omit for open-ended lists. */
  keyOf?: (line: T) => string;
  /** Keys we must end up with. Gaps trigger the one recovery call. Needs `keyOf` + `followUpUser`. */
  expectedKeys?: string[];
  /** Prompt asking for ONLY the listed keys — must re-include their full context. */
  followUpUser?: (missing: string[]) => string;
  /** Drives the timeout, the grouping wording, and progress totals. */
  expectedLines?: number;
  /** Writing no lines is a legitimate answer (the rule filter finding nothing). */
  zeroLinesOk?: boolean;
  /** Called with the count of complete lines as they land, for progress UI. Never decreases. */
  onLines?: (completeLines: number) => void;
  signal?: AbortSignal;
  /** Override the model for this call (defaults to `ANTHROPIC_MODEL`). */
  model?: string;
}

const OUTPUT_FILE = "out.jsonl";
const POLL_MS = 1000;

/**
 * One structured Claude call through the logged-in `claude` CLI, answered as JSONL in a scratch
 * sandbox rather than as response text — see `jsonl.ts` for why. Returns every line that survived
 * validation, which may be fewer than asked for: callers own the degrade.
 */
export async function structuredCall<T>(opts: StructuredCallInput<T>): Promise<T[]> {
  const model = cliModel(opts.model ?? config.ANTHROPIC_MODEL);
  const started = Date.now();
  const sandboxes: string[] = [];
  // Progress is reported across BOTH calls, so it never walks backwards when the recovery call
  // starts a fresh (empty) file of its own.
  let reported = 0;
  const report = opts.onLines
    ? (n: number) => {
        if (n > reported) {
          reported = n;
          opts.onLines!(n);
        }
      }
    : undefined;

  try {
    const main = await runInSandbox(opts, model, opts.user, opts.expectedLines, sandboxes, report);

    let merged = opts.keyOf ? mergeByKey(main.lines, opts.keyOf) : null;
    let lines = merged ? [...merged.values()] : main.lines;
    let malformed = main.malformed.length;
    let notional = main.notionalUsd;
    let missing = opts.expectedKeys && merged ? missingKeys(opts.expectedKeys, new Set(merged.keys())) : [];
    // Whether the LAST call ended cleanly — a recovery that succeeds makes an empty result
    // trustworthy again, which is what separates "no violations" from "the call died".
    let cleanExit = main.ok;
    let detail = main.detail;

    // ONE recovery call, never two. Two shapes, same call: fill the gaps when we know which keys
    // are missing, or plainly retry when the whole call died and left nothing (the CLI reports
    // transient failures — "Not logged in", usage limits — as a clean is_error with no output).
    const gapRecovery = missing.length > 0 && !!opts.followUpUser;
    const emptyRetry = lines.length === 0 && !main.ok;
    if ((gapRecovery || emptyRetry) && !opts.signal?.aborted) {
      const recoveryUser = gapRecovery ? opts.followUpUser!(missing) : opts.user;
      const recoveryLines = gapRecovery ? missing.length : opts.expectedLines;
      console.warn(
        `[claude-cli] recovery call: ${gapRecovery ? `${missing.length} missing line(s)` : `nothing salvaged (${main.detail})`}`,
      );
      const salvaged = lines.length;
      const retry = await runInSandbox(opts, model, recoveryUser, recoveryLines, sandboxes, (n) =>
        report?.(salvaged + n),
      );
      notional += retry.notionalUsd;
      malformed += retry.malformed.length;
      cleanExit = retry.ok;
      detail = retry.detail || detail;
      if (opts.keyOf) {
        merged = mergeByKey([...(merged ? [...merged.values()] : []), ...retry.lines], opts.keyOf);
        lines = [...merged.values()];
        missing = opts.expectedKeys ? missingKeys(opts.expectedKeys, new Set(merged.keys())) : [];
      } else {
        lines = [...lines, ...retry.lines];
      }
    }

    if (lines.length === 0 && !(opts.zeroLinesOk && cleanExit)) {
      throw new ClaudeError("bad_output", `claude CLI produced no valid lines: ${detail || "empty output"}`, true);
    }

    console.log(
      `[claude-cli] ${model} done in ${Math.round((Date.now() - started) / 1000)}s ` +
        `(${lines.length} lines${missing.length ? `, ${missing.length} missing` : ""}` +
        `${malformed ? `, ${malformed} malformed` : ""}; subscription; notional $${notional.toFixed(2)})`,
    );
    if (missing.length) {
      console.warn(`[claude-cli] unfilled after recovery: ${missing.slice(0, 10).join(", ")}`);
    }
    return lines;
  } finally {
    await Promise.all(sandboxes.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
  }
}

// ---------- CLI backend: run prompts through the logged-in `claude` CLI (subscription) ----------

// The subscription CLI serves the opus/sonnet tiers; haiku isn't a primary model there — and
// under a subscription the cheap-tier motivation disappears anyway.
const cliModel = (model: string): string => (/haiku/.test(model) ? "claude-sonnet-5" : model);

interface SandboxResult<T> {
  ok: boolean;
  detail: string;
  lines: T[];
  malformed: string[];
  notionalUsd: number;
}

/** Run one call in a fresh sandbox and read back whatever landed in the file — even on failure. */
async function runInSandbox<T>(
  opts: StructuredCallInput<T>,
  model: string,
  user: string,
  expectedLines: number | undefined,
  sandboxes: string[],
  onLines?: (completeLines: number) => void,
): Promise<SandboxResult<T>> {
  const dir = await mkdtemp(join(tmpdir(), "sb-claude-"));
  sandboxes.push(dir);
  const file = join(dir, OUTPUT_FILE);
  const system = `${opts.system}\n\n${buildFileProtocolBlock({
    outputPath: file,
    lineSchema: opts.lineSchema,
    expectedLines,
    zeroLinesOk: opts.zeroLinesOk,
  })}`;

  const args = [
    "-p",
    "--output-format", "json",
    "--model", model,
    "--effort", opts.effort,
    // The answer arrives as a file, so the agent needs write access — but ONLY to its own
    // sandbox. Verified on 2.1.218: --add-dir is what grants it (acceptEdits alone denies even
    // the sandbox), and with only that directory granted, writes anywhere else are denied.
    // --tools drops Bash and the web tools entirely. Member-written text reaches these prompts,
    // so the worst a prompt injection can reach is a temp dir we delete on the way out.
    "--permission-mode", "acceptEdits",
    "--add-dir", dir,
    "--tools", "Write,Edit,Read",
    "--system-prompt", system,
  ];

  const stop = onLines ? pollLines(file, onLines, opts.signal) : () => {};
  try {
    const outcome = await runCli(args, user, dir, callTimeoutMs(expectedLines), opts.signal);
    const text = await readFile(file, "utf8").catch(() => "");
    const { valid, malformed } = parseJsonl(text, opts.parseLine);
    if (outcome.ok && outcome.resultText.trim().toLowerCase() !== "done") {
      console.warn(`[claude-cli] unexpected final reply: ${outcome.resultText.slice(0, 120)}`);
    }
    return { ok: outcome.ok, detail: outcome.detail, lines: valid, malformed, notionalUsd: outcome.notionalUsd };
  } finally {
    stop();
  }
}

/** Watch the output file so a long call can report progress. Cheap by design: no JSON parsing. */
function pollLines(file: string, onLines: (n: number) => void, signal?: AbortSignal): () => void {
  let last = 0;
  const timer = setInterval(() => {
    if (signal?.aborted) return;
    readFile(file, "utf8")
      .then((text) => {
        const n = countCompleteLines(text);
        // Monotonic: the agent may rewrite the file wholesale, and progress must never walk back.
        if (n > last) {
          last = n;
          onLines(n);
        }
      })
      .catch(() => {});
  }, POLL_MS);
  return () => clearInterval(timer);
}

interface CliOutcome {
  /** The process exited cleanly AND the CLI did not report an error of its own. */
  ok: boolean;
  detail: string;
  resultText: string;
  notionalUsd: number;
}

/**
 * Spawn the CLI. Resolves with an outcome for anything the file might still have survived —
 * timeouts, non-zero exits, `is_error` envelopes — because the salvage read happens either way.
 * Only an aborted run or a missing binary reject: neither can have produced output.
 */
function runCli(
  args: string[],
  stdin: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CliOutcome> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // The CLI prefers an API key from the environment over the subscription login — strip the
    // billing paths so a personal run can never accidentally charge API credits.
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_BASE_URL;
    const child = execFile(
      "claude",
      args,
      // cwd = the call's own sandbox: it is where `out.jsonl` goes, and it keeps the CLI from
      // pulling this (or any) repo's project context into the call.
      { cwd, env, maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs, signal },
      (err, stdout, stderr) => {
        const out = stdout?.toString() ?? "";
        if (err) {
          if (signal?.aborted) {
            reject(new ClaudeError("connection", "claude CLI failed: aborted", false));
            return;
          }
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            reject(new ClaudeError("connection", "claude CLI not found on PATH", false));
            return;
          }
          // The CLI reports its own failures (usage limits, bad model, auth) on STDOUT and leaves
          // stderr empty, so stderr-or-err.message yielded a bare "Command failed: claude -p …"
          // that echoed the whole prompt back and said nothing. Prefer stderr, fall back to
          // stdout, and only then to the useless message.
          const killed = (err as { killed?: boolean }).killed;
          const detail = killed
            ? `timed out after ${Math.round(timeoutMs / 60_000)}min`
            : stderr?.toString().trim().slice(0, 300) || readEnvelope(out).result.slice(0, 300) || err.message;
          resolve({ ok: false, detail, resultText: "", notionalUsd: readEnvelope(out).notionalUsd });
          return;
        }
        const { result, isError, notionalUsd } = readEnvelope(out);
        resolve({
          ok: !isError,
          detail: isError ? result.slice(0, 300) : "",
          resultText: result,
          notionalUsd,
        });
      },
    );
    child.stdin?.write(stdin);
    child.stdin?.end();
  });
}

/** `--output-format json` prints one JSON object with the assistant text in `.result`. */
function readEnvelope(stdout: string): { result: string; isError: boolean; notionalUsd: number } {
  try {
    const lastLine = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
    const envelope = JSON.parse(lastLine) as { result?: string; is_error?: boolean; total_cost_usd?: number };
    return {
      result: typeof envelope.result === "string" ? envelope.result : "",
      isError: envelope.is_error === true,
      notionalUsd: envelope.total_cost_usd ?? 0,
    };
  } catch {
    // No envelope. The file is the source of truth, so this is only a loss of telemetry.
    return { result: "", isError: false, notionalUsd: 0 };
  }
}
