import type { Request, Response } from "express";
import type { BookRef, PromptPreview, RunRequest } from "@sb/shared";
import { config } from "../config";
import { resolveMembers, resolveQuality, resolveRunHistory } from "../domain/request";
import { pastReadsHistory } from "../pastReadsStore";
import { seedPool } from "../pipeline/candidates";
import { lensAsk, lensesFor } from "../pipeline/stage1";
import { STAGE1_SYSTEMS, STAGE3_SYSTEM, assembleStage1User } from "../prompts/assemble";

/**
 * POST /api/run/preview → the assembled prompts WITHOUT calling Claude (the "Show Prompt"
 * modal). Stage 1 runs as parallel lens passes over one shared user prompt. The preview must
 * show what THIS run would actually send: only the lenses this member count uses (solo drops
 * bridges), with each pass's real ask line and quota. Stage 3's user prompt can only be built
 * after Stage-2 verification, so it stays a placeholder.
 */
export function handlePreview(req: Request, res: Response): void {
  const body = (req.body ?? {}) as RunRequest;
  const members = resolveMembers(body);
  // Same merge as the run, so Show-Prompt is honest about what the store contributes.
  const history = resolveRunHistory(body, pastReadsHistory());
  // The SAME seeding the run does, exclusions included — otherwise the preview shows the model
  // a book (a liked one the group has since read together) that the real run drops.
  const seededRefs: BookRef[] = seedPool(members, history).map((c) => ({
    title: c.title,
    ...(c.author ? { author: c.author } : {}),
  }));

  const lenses = lensesFor(members.length);
  const systems = lenses.map((lens) => `--- ${lens.toUpperCase()} pass ---\n\n${STAGE1_SYSTEMS[lens]}`).join("\n\n");
  const otherAsks = lenses
    .slice(1)
    .map((lens) => `— ${lens}: ${lensAsk(lens, members.length)}`)
    .join("\n");

  const { model, effort } = resolveQuality(body, config.ANTHROPIC_EFFORT);
  const preview: PromptPreview = {
    model: model ?? config.ANTHROPIC_MODEL,
    effort,
    stage1: {
      system: systems,
      user: members.length
        ? assembleStage1User(members, seededRefs, history, lensAsk(lenses[0]!, members.length)) +
          (otherAsks ? `\n\n(The other pass shares this user prompt with its own ask line:\n${otherAsks})` : "")
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
