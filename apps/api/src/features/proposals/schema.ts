import { z } from "zod";

export const proposalStatusBodySchema = z.object({
  status: z.enum(["draft", "ready", "branch-pushed", "pr-opened", "merged", "rejected"])
});

export const draftFromGapsBodySchema = z.object({
  summary: z.string().optional(),
  summaries: z.array(z.string()).optional(),
  targetPath: z.string().optional(),
  flowId: z.string().optional(),
  sourceIds: z.array(z.string()).optional(),
  destinationId: z.string().optional()
});
