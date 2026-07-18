import { z } from "zod";

// One question per array entry; the console splits pasted text client-side.
// The 500 cap is a sanity bound, not a product limit — the drip means size only
// affects duration, but an unbounded body invites accidental megabyte pastes.
// Each entry also becomes one DB row + one embedding, so bound the per-question
// length (not just the array count) to keep a single giant paste from being
// persisted/embedded (#293). 4000 chars is generous for a real question.
export const createQuestionnaireSchema = z.object({
  name: z.string().trim().min(1).max(500),
  flowId: z.string().min(1).max(200),
  questions: z.array(z.string().max(4000)).min(1).max(500)
});

export const exportQuerySchema = z.object({
  format: z.enum(["md", "csv"]).default("md")
});
