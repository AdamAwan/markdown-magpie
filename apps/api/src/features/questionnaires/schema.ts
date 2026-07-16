import { z } from "zod";

// One question per array entry; the console splits pasted text client-side.
// The 500 cap is a sanity bound, not a product limit — the drip means size only
// affects duration, but an unbounded body invites accidental megabyte pastes.
export const createQuestionnaireSchema = z.object({
  name: z.string().trim().min(1),
  flowId: z.string().min(1),
  questions: z.array(z.string()).min(1).max(500)
});

export const exportQuerySchema = z.object({
  format: z.enum(["md", "csv"]).default("md")
});
