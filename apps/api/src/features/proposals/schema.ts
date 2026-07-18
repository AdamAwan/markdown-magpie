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

// Per-string and per-array bounds so a bulk draft can't smuggle unbounded gap
// summaries / id lists past the global body cap (#293). Summaries are free text
// (a sentence or two); ids and paths are short identifiers.
export const draftFromGapsBodySchema = z.object({
  summary: z.string().max(2000).optional(),
  summaries: z.array(z.string().max(2000)).max(200).optional(),
  targetPath: z.string().max(1024).optional(),
  flowId: z.string().max(200).optional(),
  sourceIds: z.array(z.string().max(200)).max(200).optional(),
  destinationId: z.string().max(200).optional()
});
