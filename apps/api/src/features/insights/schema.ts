import { z } from "zod";

// Shared query params for the time-series insight endpoints. `from`/`to` are
// optional ISO timestamps; the service defaults them to the last 30 days.
// `bucket` is the date_trunc granularity; `flow` narrows to a single flow.
export const insightsRangeQuerySchema = z.object({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  bucket: z.enum(["day", "week", "month"]).default("day"),
  flow: z.string().trim().min(1).optional()
});

export type InsightsRangeQuery = z.infer<typeof insightsRangeQuerySchema>;

// Job-throughput query params: the shared range plus an optional `type` narrowing
// to a single job type (resolved to its pg-boss queue names by the service).
export const jobThroughputQuerySchema = insightsRangeQuerySchema.extend({
  type: z.string().trim().min(1).optional()
});

export type JobThroughputQuery = z.infer<typeof jobThroughputQuerySchema>;

// The answer-latency histogram (C4) has no time axis — it bins by latency range,
// not by bucket — so it accepts only the window bounds. A bucket is still resolved
// internally (defaulted to "day") to satisfy the shared InsightsRange, but it does
// not affect the result.
export const insightsWindowQuerySchema = z.object({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional()
});

export type InsightsWindowQuery = z.infer<typeof insightsWindowQuerySchema>;
