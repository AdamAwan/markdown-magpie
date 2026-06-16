import { z } from "zod";

export const createJobBodySchema = z.object({
  type: z.enum([
    "answer_question",
    "summarize_gap",
    "draft_markdown_proposal",
    "detect_contradiction",
    "suggest_consolidation",
    "crunch_knowledge_base"
  ]),
  input: z.unknown().optional()
});
