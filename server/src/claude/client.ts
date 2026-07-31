import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "@sb/shared";
import { config } from "../config";

// Lazy: in CLI-backend mode there may be no API key at all.
let _anthropic: Anthropic | null = null;
const anthropicClient = (): Anthropic => (_anthropic ??= new Anthropic({ apiKey: config.ANTHROPIC_API_KEY }));

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

// Models that accept output_config.effort + adaptive thinking. Haiku 4.5 (our cheap default)
// and older models do NOT — sending effort to them is a 400, so we omit it for them.
function supportsEffort(model: string): boolean {
  return /opus-4|sonnet-5|sonnet-4-6|fable/.test(model);
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
 * One structured-output Claude call. Streamed under the hood (`finalMessage()` reassembles):
 * a multi-member Stage 3 can generate for minutes, and a non-streaming call is silent on the
 * wire the whole time — long enough for NAT/router idle timeouts to kill the connection
 * ("Connection error" at ~3min). Streaming keeps bytes flowing; we still return only the end.
 */
export async function structuredCall<T>(opts: StructuredCallInput<T>): Promise<T> {
  const model = opts.model ?? config.ANTHROPIC_MODEL;
  // CLI backend: the organizer's own Claude subscription (via the logged-in `claude` CLI)
  // instead of pay-per-token API billing. Single-user, local-machine mode.
  if (config.CLAUDE_BACKEND === "cli") return cliStructuredCall(opts, model);

  const outputConfig: Anthropic.Messages.OutputConfig = {
    format: { type: "json_schema", schema: opts.jsonSchema },
  };
  const params: Anthropic.Messages.MessageStreamParams = {
    model,
    max_tokens: opts.maxTokens,
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
    output_config: outputConfig,
  };
  if (supportsEffort(model)) {
    outputConfig.effort = opts.effort;
    params.thinking = { type: "adaptive" };
  }

  // Auto-retry transient failures (idempotent call, so safe): a connection blip, or Anthropic
  // being overloaded (529) / 5xx — both common and self-healing. NOT 429 (real rate limit).
  const MAX_RETRIES = 2;
  let res: Anthropic.Messages.Message | null = null;
  for (let attempt = 0; res === null; attempt++) {
    try {
      const started = Date.now();
      const stream = anthropicClient().messages.stream(params, { signal: opts.signal });
      // Coarse progress log so a long generation is observable (and a hang is diagnosable).
      let chars = 0;
      let lastLog = 0;
      stream.on("text", (t) => {
        chars += t.length;
        if (chars - lastLog >= 40_000) {
          lastLog = chars;
          console.log(`[claude] streaming… ~${Math.round(chars / 1000)}k chars in ${Math.round((Date.now() - started) / 1000)}s`);
        }
      });
      res = await stream.finalMessage();
      const u = res.usage;
      console.log(
        `[claude] done: ${u.input_tokens} in + ${u.output_tokens} out tokens` +
          `${u.cache_read_input_tokens ? ` (${u.cache_read_input_tokens} cached)` : ""}` +
          ` in ${Math.round((Date.now() - started) / 1000)}s (stop: ${res.stop_reason})`,
      );
    } catch (err) {
      const status = err instanceof Anthropic.APIError ? err.status ?? 0 : 0;
      const retryable =
        !opts.signal?.aborted &&
        (err instanceof Anthropic.APIConnectionError || status === 529 || status >= 500);
      if (retryable && attempt < MAX_RETRIES) {
        const wait = 1500 * (attempt + 1);
        console.warn(`[claude] ${status ? `HTTP ${status}` : "connection error"} — retry ${attempt + 1}/${MAX_RETRIES} in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw toClaudeError(err);
    }
  }

  if (res.stop_reason === "refusal") {
    const category = (res.stop_details as { category?: string | null } | null | undefined)?.category ?? null;
    throw new ClaudeError("refusal", `The model declined this request${category ? ` (${category})` : ""}.`, false);
  }
  if (res.stop_reason === "max_tokens") {
    throw new ClaudeError("truncated", `The model hit the ${opts.maxTokens}-token output cap — output is incomplete.`, false);
  }

  const text = res.content.find((b): b is Anthropic.Messages.TextBlock => b.type === "text");
  if (!text) throw new ClaudeError("bad_output", "No text content in the model response.", true);

  let raw: unknown;
  try {
    raw = JSON.parse(text.text);
  } catch {
    throw new ClaudeError("bad_output", "Model output was not valid JSON.", true);
  }
  try {
    return opts.validate(raw);
  } catch (e) {
    throw new ClaudeError("bad_output", `Model output did not match the schema: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

function toClaudeError(err: unknown): ClaudeError {
  if (err instanceof Error && err.name === "AbortError") {
    return new ClaudeError("aborted", "Aborted", false);
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    const retryable = status === 429 || status >= 500;
    const code = status === 401 ? "auth" : status === 403 ? "forbidden" : status === 429 ? "rate_limited" : status >= 500 ? "server" : "api_error";
    return new ClaudeError(code, `Anthropic API error${status ? ` (${status})` : ""}: ${err.message}`, retryable);
  }
  return new ClaudeError("api_error", err instanceof Error ? err.message : "Unknown API error", true);
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
          const detail = signal?.aborted ? "aborted" : stderr?.toString().slice(0, 300) || err.message;
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
  const args = ["-p", "--output-format", "json", "--model", cliModel(model), "--system-prompt", system];

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
