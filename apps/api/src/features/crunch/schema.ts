import { isValidCron } from "@magpie/core";
import { z } from "zod";

export const crunchRunBodySchema = z.object({
  flowId: z.string().optional()
});

export const crunchSettingsBodySchema = z.object({
  flowId: z.string().optional(),
  enabled: z.boolean().optional(),
  cron: z.string().trim().refine(isValidCron)
});
