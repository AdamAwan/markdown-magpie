import { z } from "zod";

// Body for proposing a seed plan: optional freeform steer only. The planner
// derives scope from the flow's charter/sources — there is no topic.
export const outlineBodySchema = z.object({
  notes: z.string().optional()
});

// Reviewer edits to a proposed plan: charter/persona text plus per-item field
// edits and status flips, addressed by the items' stable ids. Coverage points,
// when supplied, must be non-empty strings (approval separately requires every
// approvable item to keep at least one).
export const seedPlanPatchSchema = z.object({
  charter: z.string().optional(),
  persona: z.string().optional(),
  items: z
    .array(
      z.object({
        id: z.string(),
        title: z.string().optional(),
        targetPath: z.string().optional(),
        coverage: z.array(z.string().min(1)).optional(),
        questions: z.array(z.string()).optional(),
        status: z.enum(["proposed", "approved", "dismissed"]).optional()
      })
    )
    .optional()
});
// The service/provider-facing type for PATCH bodies.
export type SeedPlanPatchBody = z.infer<typeof seedPlanPatchSchema>;

// Body for revising a plan: a non-empty natural-language instruction to reshape
// it by ("don't mention X", "merge the API docs"). Trimmed so whitespace-only
// input is rejected.
export const seedPlanReviseSchema = z.object({
  instruction: z.string().trim().min(1)
});
