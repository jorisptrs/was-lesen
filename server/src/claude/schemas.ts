import { z } from "zod";

// Every structured call is answered as JSONL — one object per line — so these describe a LINE,
// not a whole response. Each stage pairs a zod schema (validates what came back) with a plain
// JSON Schema (goes into the prompt), kept decoupled from any zod version.

// Stage 1 — candidate generation. Title + author only (no scores).

export const Stage1LineSchema = z.object({
  title: z.string(),
  author: z.string(),
});
export type Stage1Line = z.infer<typeof Stage1LineSchema>;

export const STAGE1_LINE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    author: { type: "string" },
  },
  required: ["title", "author"],
};

// Stage 3 — per-member scoring + card fields, keyed by the verified book `id`. The app (not
// the model) computes avg fit and does the selection; scores are clamped server-side.

// No `clusterLabel`: map labels come solely from the post-clustering `nameClusters` call, which
// sees the actual embedding groups. The per-book label only ever fed fallbacks, and asking for
// it invited Stage 3 to invent a taxonomy the geometry then ignored (M36).
export const Stage3LineSchema = z.object({
  id: z.string(),
  complexity: z.enum(["light", "moderate", "demanding"]),
  mode: z.enum(["comfort", "stretch"]),
  summary: z.string(),
  discussability: z.number(),
  rationale: z.string(),
  expedition: z.boolean(),
  perMember: z.array(z.object({ member: z.string(), fit: z.number() })),
});
export type Stage3Line = z.infer<typeof Stage3LineSchema>;

export const STAGE3_LINE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    complexity: { type: "string", enum: ["light", "moderate", "demanding"] },
    mode: { type: "string", enum: ["comfort", "stretch"] },
    summary: { type: "string" },
    discussability: { type: "number" },
    rationale: { type: "string" },
    expedition: { type: "boolean" },
    perMember: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { member: { type: "string" }, fit: { type: "number" } },
        required: ["member", "fit"],
      },
    },
  },
  required: [
    "id",
    "complexity",
    "mode",
    "summary",
    "discussability",
    "rationale",
    "expedition",
    "perMember",
  ],
};

// Stage 0 — normalize raw human-typed book strings from the intake form into canonical
// published title + author. Conservative by design: fix, never invent.
//
// One request carries three independent lists (entries, paragraphs, rules), so a line says which
// list it belongs to and echoes the 1-based number it was given. Indices, not order: lines can
// arrive in any order across turns, and a dropped one must not shift its neighbours.

export const NormalizeLineSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("entry"),
    index: z.number().int(),
    original: z.string(),
    kind: z.enum(["book", "not_a_book", "rule"]),
    title: z.string(),
    author: z.string(),
    /** True only if the author name literally appears in the original string (not inferred). */
    authorFromText: z.boolean(),
  }),
  /** A member paragraph with pleasantries/meta removed. */
  z.object({ type: z.literal("paragraph"), index: z.number().int(), text: z.string() }),
  /** A cleaned group-rule line. */
  z.object({ type: z.literal("rule"), index: z.number().int(), text: z.string() }),
]);
export type NormalizeLine = z.infer<typeof NormalizeLineSchema>;

export const NORMALIZE_LINE_JSON_SCHEMA: Record<string, unknown> = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { const: "entry" },
        index: { type: "integer" },
        original: { type: "string" },
        kind: { type: "string", enum: ["book", "not_a_book", "rule"] },
        title: { type: "string" },
        author: { type: "string" },
        authorFromText: { type: "boolean" },
      },
      required: ["type", "index", "original", "kind", "title", "author", "authorFromText"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { const: "paragraph" },
        index: { type: "integer" },
        text: { type: "string" },
      },
      required: ["type", "index", "text"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { const: "rule" },
        index: { type: "integer" },
        text: { type: "string" },
      },
      required: ["type", "index", "text"],
    },
  ],
};

// Constraint filter — post-verification pass that removes books clearly violating group rules.
// Violations are a SUBSET of the books, so writing no lines is the normal "nothing to report".

export const FilterLineSchema = z.object({
  id: z.string(),
  rule: z.string(),
  reason: z.string(),
});
export type FilterLine = z.infer<typeof FilterLineSchema>;

export const FILTER_LINE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    rule: { type: "string" },
    reason: { type: "string" },
  },
  required: ["id", "rule", "reason"],
};

// Cluster naming — one short topic label per book group (the map's blob labels). `group` is the
// 1-based number the prompt used, so the model never has to translate between numbering schemes.

export const ClusterNameLineSchema = z.object({
  group: z.number().int(),
  label: z.string(),
});
export type ClusterNameLine = z.infer<typeof ClusterNameLineSchema>;

export const CLUSTER_NAME_LINE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    group: { type: "integer" },
    label: { type: "string" },
  },
  required: ["group", "label"],
};
