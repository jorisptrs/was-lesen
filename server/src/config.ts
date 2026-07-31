import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

// Config source: the repo-root .env as the base, overridden by any NON-EMPTY real env var.
//
// Two deliberate choices:
//  - We resolve the .env relative to this file, not the cwd, because npm launches the server
//    from the server workspace dir.
//  - An exported-but-empty var (e.g. `ANTHROPIC_API_KEY=""`, which some shells/harnesses set)
//    is treated as unset so .env can fill it — rather than silently clobbering the .env value.
//    A real, non-empty env var still wins over .env (standard 12-factor precedence).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fromDotenv = dotenv.config({ path: resolve(repoRoot, ".env"), processEnv: {} }).parsed ?? {};

// Empty means "unset" from BOTH sources. .env.example ships optional keys with empty values
// (FILTER_MODEL=, PUBLISH_TARGET=) to document them, so `cp .env.example .env` — the documented
// first step — must not fail validation: an empty string is not a valid URL, and a zod
// .default() only fires on an ABSENT key, never on an empty one.
const source: Record<string, string | undefined> = {};
for (const [key, value] of Object.entries(fromDotenv)) {
  if (value !== "") source[key] = value;
}
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && value !== "") source[key] = value;
}

const schema = z.object({
  // "api" bills pay-per-token via ANTHROPIC_API_KEY. "cli" shells out to the logged-in
  // `claude` CLI instead — the organizer's own subscription covers personal local runs, no
  // API credits touched. CLI mode is for the laptop, not a host (no login there).
  CLAUDE_BACKEND: z.enum(["api", "cli"]).default("api"),
  ANTHROPIC_API_KEY: z.string().optional(),
  // Cheapest by default (scarce API credits); up the model at deployment. Note: Haiku 4.5
  // does NOT accept output_config.effort — the Claude client omits effort/thinking for it.
  ANTHROPIC_MODEL: z.string().min(1).default("claude-haiku-4-5"),
  // Stage-0 title normalization can use a stronger model for accuracy (recent/foreign titles);
  // defaults to ANTHROPIC_MODEL. It's one cheap call per import.
  NORMALIZE_MODEL: z.string().optional(),
  // The constraint-filter judgment call defaults to Sonnet: Haiku demonstrably misapplies rules
  // (invented length limits, wrong same-title books, allowed languages flagged) and the call is
  // ~1k tokens (~$0.005/run) — the one place a stronger model is worth it by default.
  FILTER_MODEL: z.string().min(1).default("claude-sonnet-5"),
  ANTHROPIC_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
  MAX_EFFORT_PASSPHRASE: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  TRUST_PROXY: z.string().optional(),
  OPENLIBRARY_USER_AGENT: z.string().min(1).default("SatisfyingBooks/0.1"),
  RUN_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(10),
  MAX_CONCURRENT_RUNS: z.coerce.number().int().positive().default(3),
  BOOKS_CONCURRENCY: z.coerce.number().int().positive().default(5),
  // Embeddings position the cluster map semantically. "local" runs a small model in-process
  // (no key, no cost, offline); "voyage"/"openai" need EMBEDDINGS_API_KEY; "none" disables it
  // (the map uses a deterministic layout). Embeddings never fail a run — errors fall back.
  EMBEDDINGS_PROVIDER: z.enum(["local", "voyage", "openai", "none"]).default("local"),
  EMBEDDINGS_API_KEY: z.string().optional(),
  // Optional: raises the Google Books quota (the keyless ~1000/day is plenty for group use).
  GOOGLE_BOOKS_API_KEY: z.string().optional(),
  // Publish forwarding: when set, a local publish is sent to THIS hosted app instead of the
  // local slot — run on the laptop (subscription), appear online in one click. The
  // passphrase is the hosted app's APP_PASSPHRASE (kept separate so setting it locally
  // doesn't lock the local app itself).
  PUBLISH_TARGET: z.string().url().optional(),
  PUBLISH_PASSPHRASE: z.string().optional(),
  // With a passphrase set, the whole API except /api/health and /api/current is
  // organizer-only: visitors see the latest published map read-only, and only the organizer
  // can start runs or publish. Unset (e.g. local dev) = everything open.
  APP_PASSPHRASE: z.string().optional(),
  NODE_ENV: z.string().default("development"),
});

const checked = schema.superRefine((v, ctx) => {
  if (v.CLAUDE_BACKEND === "api" && !v.ANTHROPIC_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ANTHROPIC_API_KEY"],
      message: "required unless CLAUDE_BACKEND=cli",
    });
  }
});
const parsed = checked.safeParse(source);
if (!parsed.success) {
  const details = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
  console.error(`[config] Invalid environment:\n${details}\n\nSee .env.example.`);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
