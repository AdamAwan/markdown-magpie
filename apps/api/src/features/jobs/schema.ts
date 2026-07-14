import { AI_PROVIDERS, JOB_TYPES } from "@magpie/jobs";
import { z } from "zod";

const jobTypeSchema = z.enum(JOB_TYPES);
const capabilitySchema = z.enum([...AI_PROVIDERS, "github", "local-git", "maintenance"]);
const jobStateSchema = z.enum(["created", "retry", "active", "completed", "cancelled", "failed", "blocked"]);

export const createJobBodySchema = z.object({ type: jobTypeSchema, input: z.unknown().optional() });
export const listJobsQuerySchema = z.object({
  type: jobTypeSchema.optional(),
  state: jobStateSchema.optional(),
  createdAfter: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0)
});
export const claimJobBodySchema = z.object({
  workerName: z.string().trim().min(1),
  capabilities: z.array(capabilitySchema).min(1)
});
// Heartbeats carry the watcher's name so the registry can keep it marked busy on
// the job it is running. Optional so older watchers (and internal callers) still
// heartbeat fine; they just don't refresh their liveness.
export const heartbeatJobBodySchema = z.object({
  workerName: z.string().trim().min(1).optional()
});
// The watcher's summed provider-reported token usage for the run (#241).
// Optional end to end: CLI providers report nothing, and older watchers don't
// send the field at all. Bounded to non-negative integers so a confused
// provider can't persist NaN/negative counts into the completion envelope.
export const jobUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional()
});
export const completeJobBodySchema = z.object({
  output: z.unknown(),
  executor: z.string().trim().min(1).optional(),
  usage: jobUsageSchema.optional()
});
export const failJobBodySchema = z.object({
  error: z.object({
    code: z.string().min(1), message: z.string().min(1),
    category: z.enum(["provider", "validation", "configuration", "timeout", "external", "internal"]),
    provider: z.string().optional(),
    details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    executor: z.string().optional()
  })
});
