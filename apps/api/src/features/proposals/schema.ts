import { z } from "zod";

export const proposalStatusBodySchema = z.object({
  status: z.enum(["draft", "ready", "branch-pushed", "pr-opened", "merged", "rejected", "superseded"])
});

// One console bulk action applied across explicit ids. Ids stay explicit (no
// "all in status X" form) so the UI selection and the API agree on exactly what
// was acted on; 100 matches the console's proposals fetch page.
export const bulkProposalActionBodySchema = z.object({
  action: z.enum(["ready", "publish", "merge", "reject"]),
  ids: z.array(z.string()).min(1).max(100)
});

export const draftFromGapsBodySchema = z.object({
  summary: z.string().optional(),
  summaries: z.array(z.string()).optional(),
  targetPath: z.string().optional(),
  flowId: z.string().optional(),
  sourceIds: z.array(z.string()).optional(),
  destinationId: z.string().optional()
});
