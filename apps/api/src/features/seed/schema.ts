import { z } from "zod";

// One document to author when seeding a flow. `coverage` is the substantive field
// (the points the doc must cover); everything else is optional shaping.
const seedItemSchema = z.object({
  title: z.string().optional(),
  targetPath: z.string().optional(),
  coverage: z.array(z.string().min(1)).min(1),
  questions: z.array(z.string()).optional()
});

export const seedBodySchema = z.object({
  items: z.array(seedItemSchema).min(1)
});

// Body for generating a seed outline: a topic to plan coverage for, plus optional
// freeform notes. The outline job proposes the SeedItem[]; a human reviews before
// seeding.
export const outlineBodySchema = z.object({
  topic: z.string().min(1),
  notes: z.string().optional()
});
