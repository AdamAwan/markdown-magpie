import { z } from "zod";

// `flow` pins the question to a knowledge flow. Absent or "auto" means let the
// watcher route it; any other value must match a configured flow id (validated in
// the service, which has the flow list).
export const askBodySchema = z.object({
  question: z.string().trim().min(1),
  flow: z.string().trim().min(1).optional()
});
