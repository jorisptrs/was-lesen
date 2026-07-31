import type { Request, Response } from "express";
import type { BookRef, PromptPreview, RunRequest } from "@sb/shared";
import { config } from "../config";
import { resolveHistory, resolveMembers, resolveQuality } from "../domain/request";
import { seedLoved, seedNominations } from "../pipeline/candidates";
import { lensAsk } from "../pipeline/stage1";
import { STAGE1_SYSTEMS, STAGE3_SYSTEM, assembleStage1User } from "../prompts/assemble";

/**
 * POST /api/run/preview → the assembled prompts WITHOUT calling Claude (the "Show Prompt"
 * modal). Stage 1 runs as three lens passes over one shared user prompt — the preview shows
 * all three systems and the champions-lens user prompt. Stage 3's user prompt can only be
 * built after Stage-2 verification, so it stays a placeholder.
 */
export function handlePreview(req: Request, res: Response): void {
  const body = (req.body ?? {}) as RunRequest;
  const members = resolveMembers(body);
  const history = resolveHistory(body);
  const seededRefs: BookRef[] = [...seedNominations(members), ...seedLoved(members)].map((c) => ({
    title: c.title,
    ...(c.author ? { author: c.author } : {}),
  }));

  const systems = (Object.entries(STAGE1_SYSTEMS) as [keyof typeof STAGE1_SYSTEMS, string][])
    .map(([lens, text]) => `--- ${lens.toUpperCase()} pass ---\n\n${text}`)
    .join("\n\n");

  const { model, effort } = resolveQuality(body, config.ANTHROPIC_EFFORT);
  const preview: PromptPreview = {
    model: model ?? config.ANTHROPIC_MODEL,
    effort,
    stage1: {
      system: systems,
      user: members.length
        ? assembleStage1User(members, seededRefs, history, lensAsk("champions", members.length)) +
          "\n\n(The bridges and wildcards passes share this user prompt with their own ask line.)"
        : "(add members to see the assembled Stage-1 prompt)",
    },
    stage3: {
      system: STAGE3_SYSTEM,
      userTemplate:
        "Assembled after Stage-2 verification: the group's tastes plus the verified books, " +
        "each with an id, to score.\n\n{{VERIFIED_BOOKS}}",
    },
  };
  res.json(preview);
}
