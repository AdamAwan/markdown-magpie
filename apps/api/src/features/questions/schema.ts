import { z } from "zod";

export const feedbackBodySchema = z.object({
  feedback: z.enum(["helpful", "unhelpful"])
});

export const manualGapBodySchema = z.object({
  summary: z.string().optional()
});
