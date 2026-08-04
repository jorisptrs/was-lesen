import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import type { Effort } from "@sb/shared";
import { config } from "../config";

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
  maxTokens: number;
  effort: Effort;
  /** Plain JSON Schema for output_config.format. */
  jsonSchema: Record<string, unknown>;
  /** Validate + type the parsed JSON (e.g. a zod `schema.parse`). */
  validate: (raw: unknown) => T;
  signal?: AbortSignal;
  /** Override the model for this call (defaults to `ANTHROPIC_MODEL`). */
  model?: string;
}

/**
 * One structured-output Claude call, always through the logged-in `claude` CLI.
 * `effort` and `jsonSchema` are honoured by the CLI path (`--effort`, and the schema restated
 * in the system prompt); `maxTokens` is advisory only — see the cap note on `runCli`.
 */
export async function structuredCall<T>(opts: StructuredCallInput<T>): Promise<T> {
  return cliStructuredCall(opts, opts.model ?? config.ANTHROPIC_MODEL);
}

// ---------- CLI backend: run prompts through the logged-in `claude` CLI (subscription) ----------

/** Extract the first complete JSON object from model text (tolerates prose/fences around it). */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (esc) {
      esc = false;
      continue;
    }
    if (c === "\\") {
      if (inStr) esc = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Escape raw control characters inside JSON string literals. Without the API's structured
 * output enforcement, models emit REAL newlines inside strings (two-paragraph summaries),
 * which JSON.parse rejects ("Bad control character"). */
export function escapeControlCharsInStrings(json: string): string {
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
      out += c === "\n" ? "\\n" : c === "\r" ? "\\r" : c === "\t" ? "\\t" : `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
      continue;
    }
    out += c;
  }
  return out;
}

// The subscription CLI serves the opus/sonnet tiers; haiku isn't a primary model there — and
// under a subscription the cheap-tier motivation disappears anyway.
const cliModel = (model: string): string => (/haiku/.test(model) ? "claude-sonnet-5" : model);

// KNOWN CAP: `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is NOT honoured by the CLI (verified on 2.1.219) —
// a call asking for 1024 produced 4096 output tokens, the CLI's own default, and there is no
// --max-tokens flag. So any single call whose JSON exceeds ~4096 output tokens is truncated and
// comes back `is_error`. Small calls (lens passes, filter, cluster names) fit comfortably; Stage 3
// scoring a large pool does NOT, and must be batched. We still set the env var: harmless, and it
// starts working the day the CLI honours it.
function runCli(args: string[], stdin: string, maxTokens: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(Math.min(maxTokens, 64000)) };
    // The CLI prefers an API key from the environment over the subscription login — strip the
    // billing paths so a personal run can never accidentally charge API credits.
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_BASE_URL;
    const child = execFile(
      "claude",
      args,
      // cwd = tmpdir so the CLI can't pull this (or any) repo's project context into the call.
      { cwd: tmpdir(), env, maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60_000, signal },
      (err, stdout, stderr) => {
        if (err) {
          // The CLI reports its own failures (usage limits, bad model, auth) on STDOUT and leaves
          // stderr empty, so stderr-or-err.message yielded a bare "Command failed: claude -p …"
          // that echoed the whole prompt back and said nothing. Prefer stderr, fall back to
          // stdout, and only then to the useless message.
          const out = stdout?.toString().trim() ?? "";
          const detail = signal?.aborted
            ? "aborted"
            : stderr?.toString().trim().slice(0, 300) || out.slice(0, 400) || err.message;
          reject(new ClaudeError("connection", `claude CLI failed: ${detail}`, !signal?.aborted));
        } else {
          resolve(stdout.toString());
        }
      },
    );
    child.stdin?.write(stdin);
    child.stdin?.end();
  });
}

async function cliStructuredCall<T>(opts: StructuredCallInput<T>, model: string): Promise<T> {
  const system =
    `${opts.system}\n\n` +
    `Output format (MANDATORY): respond with ONLY one JSON object that validates against this ` +
    `JSON Schema — no prose, no markdown fences, no tool use:\n${JSON.stringify(opts.jsonSchema)}`;
  // --effort was previously never passed, so every quality preset silently ran at the CLI's
  // default — the same footgun M25 removed from the UI. cliModel() maps haiku onto sonnet, and
  // every model the CLI serves takes effort, so it's unconditional.
  const args = [
    "-p",
    "--output-format", "json",
    "--model", cliModel(model),
    "--effort", opts.effort,
    "--system-prompt", system,
  ];

  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = Date.now();
    const prompt =
      attempt === 0
        ? opts.user
        : `${opts.user}\n\n(Your previous output was invalid: ${lastErr}. Output ONLY the JSON object.)`;
    const out = await runCli(args, prompt, opts.maxTokens, opts.signal);

    // Envelope: --output-format json prints one JSON object with the assistant text in .result.
    let resultText = out;
    let notional = 0;
    try {
      const lastLine = out.trim().split("\n").filter(Boolean).pop() ?? "";
      const envelope = JSON.parse(lastLine) as { result?: string; is_error?: boolean; total_cost_usd?: number };
      if (envelope.is_error) {
        lastErr = (envelope.result ?? "CLI reported an error").slice(0, 200);
        console.warn(`[claude-cli] attempt ${attempt + 1} errored: ${lastErr}`);
        continue;
      }
      if (typeof envelope.result === "string") resultText = envelope.result;
      notional = envelope.total_cost_usd ?? 0;
    } catch {
      // no envelope — treat the raw output as the model text
    }

    const json = extractJsonObject(resultText);
    if (json) {
      try {
        const value = opts.validate(JSON.parse(escapeControlCharsInStrings(json)));
        console.log(
          `[claude-cli] ${cliModel(model)} done in ${Math.round((Date.now() - started) / 1000)}s ` +
            `(subscription; notional $${notional.toFixed(2)})`,
        );
        return value;
      } catch (e) {
        lastErr = (e instanceof Error ? e.message : "schema mismatch").slice(0, 200);
      }
    } else {
      lastErr = "no JSON object found in the output";
    }
    console.warn(`[claude-cli] attempt ${attempt + 1} invalid: ${lastErr}`);
  }
  throw new ClaudeError("bad_output", `claude CLI output failed validation: ${lastErr}`, true);
}
