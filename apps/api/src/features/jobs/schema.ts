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
  // Job inputs are always object payloads (consumers read them as
  // Partial<...JobInput>); reject arrays/primitives at the boundary rather than
  // letting a malformed `as Partial` cast slip through downstream.
  input: z.record(z.string(), z.unknown()).optional()
});
