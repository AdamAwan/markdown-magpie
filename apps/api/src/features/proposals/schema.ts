import { z } from "zod";

export const proposalStatusBodySchema = z.object({
  status: z.enum(["draft", "ready", "branch-pushed", "pr-opened", "merged", "rejected"])
});
