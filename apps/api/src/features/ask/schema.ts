import { z } from "zod";

// `flow` pins the question to a knowledge flow. Absent or "auto" means let the
// watcher route it; any other value must match a configured flow id (validated in
// the service, which has the flow list).
export const askBodySchema = z.object({
  question: z.string().trim().min(1),
  flow: z.string().trim().min(1).optional(),
  // Multi-turn conversations (#239). Attach a follow-up to a prior exchange by
  // passing the `conversationId` returned with the first answer. A UUID; anything
  // else is rejected so a malformed id fails fast rather than silently starting a
  // detached thread. Absent starts a new conversation (the API mints an id).
  conversationId: z.string().uuid().optional()
});
