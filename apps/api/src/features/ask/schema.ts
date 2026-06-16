import { z } from "zod";

export const askBodySchema = z.object({
  question: z.string().trim().min(1)
});
