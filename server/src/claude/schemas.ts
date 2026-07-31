import { z } from "zod";

// Stage 1 — candidate generation. Title + author only (no scores). We validate the model's
// output with this zod schema and separately hand the API a plain JSON Schema (below) for
// output_config.format — kept decoupled from any zod version.

export const Stage1Schema = z.object({
  candidates: z.array(
    z.object({
      title: z.string(),
      author: z.string(),
    }),
  ),
});
export type Stage1Output = z.infer<typeof Stage1Schema>;

export const STAGE1_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          author: { type: "string" },
        },
        required: ["title", "author"],
      },
    },
  },
  required: ["candidates"],
};

// Stage 3 — per-member scoring + card fields, keyed by the verified book `id`. The app (not
// the model) computes avg fit and does the selection; scores are clamped server-side.

export const Stage3Schema = z.object({
  books: z.array(
    z.object({
      id: z.string(),
      clusterLabel: z.string(),
      complexity: z.enum(["light", "moderate", "demanding"]),
      mode: z.enum(["comfort", "stretch"]),
      summary: z.string(),
      discussability: z.number(),
      rationale: z.string(),
      expedition: z.boolean(),
      perMember: z.array(z.object({ member: z.string(), fit: z.number() })),
    }),
  ),
});
export type Stage3Output = z.infer<typeof Stage3Schema>;

export const STAGE3_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    books: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          clusterLabel: { type: "string" },
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
          "clusterLabel",
          "complexity",
          "mode",
          "summary",
          "discussability",
          "rationale",
          "expedition",
          "perMember",
        ],
      },
    },
  },
  required: ["books"],
};

// Stage 0 — normalize raw human-typed book strings from the intake form into canonical
// published title + author. Conservative by design: fix, never invent.

export const NormalizeSchema = z.object({
  entries: z.array(
    z.object({
      original: z.string(),
      kind: z.enum(["book", "not_a_book", "rule"]),
      title: z.string(),
      author: z.string(),
      /** True only if the author name literally appears in the original string (not inferred). */
      authorFromText: z.boolean(),
    }),
  ),
  /** Cleaned member paragraphs (pleasantries/meta removed), one per input, in order. */
  paragraphs: z.array(z.string()),
  /** Cleaned group-rule lines, one per input, in order. */
  rules: z.array(z.string()),
});
export type NormalizeOutput = z.infer<typeof NormalizeSchema>;

export const NORMALIZE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          original: { type: "string" },
          kind: { type: "string", enum: ["book", "not_a_book", "rule"] },
          title: { type: "string" },
          author: { type: "string" },
          authorFromText: { type: "boolean" },
        },
        required: ["original", "kind", "title", "author", "authorFromText"],
      },
    },
    paragraphs: { type: "array", items: { type: "string" } },
    rules: { type: "array", items: { type: "string" } },
  },
  required: ["entries", "paragraphs", "rules"],
};

// Constraint filter — post-verification pass that removes books clearly violating group rules.

export const FilterSchema = z.object({
  violations: z.array(
    z.object({
      id: z.string(),
      rule: z.string(),
      reason: z.string(),
    }),
  ),
});
export type FilterOutput = z.infer<typeof FilterSchema>;

export const FILTER_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    violations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          rule: { type: "string" },
          reason: { type: "string" },
        },
        required: ["id", "rule", "reason"],
      },
    },
  },
  required: ["violations"],
};

// Cluster naming — one short topic label per book group (the map's blob labels).

export const ClusterNamesSchema = z.object({
  labels: z.array(z.string()),
});
export type ClusterNamesOutput = z.infer<typeof ClusterNamesSchema>;

export const CLUSTER_NAMES_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    labels: { type: "array", items: { type: "string" } },
  },
  required: ["labels"],
};
