import { z } from "zod";
import type { JobType, JobView } from "@magpie/jobs";
import type { AppContext } from "../../context.js";
import { logger } from "../../logger.js";

// Size discipline (#215): the map is an index, not a mirror of the repo.
// Anything outside these caps is dropped with a warning — never a job failure.
const MAX_UPDATES_PER_JOB = 20;
const MAX_TOPIC_LENGTH = 120;
const MAX_PATHS = 8;
const MAX_PATH_LENGTH = 260;
const MAX_DESCRIPTION_LENGTH = 240;
const MAX_ENTRIES_PER_SOURCE = 200;

// The six job types whose inputs carry `sources` and whose outputs may carry
// `mapUpdates`. Anything else is a no-op here.
const SOURCE_GROUNDED_JOB_TYPES: ReadonlySet<JobType> = new Set<JobType>([
  "draft_seed_document",
  "draft_markdown_proposal",
  "outline_flow_seed",
  "verify_document",
  "correct_document",
  "improve_document"
]);

// Just the slice of the output this service consumes — the full output was
// already validated against the job contract by the completion dispatcher.
const mapUpdatesEnvelopeSchema = z.object({
  mapUpdates: z
    .array(
      z.object({
        sourceId: z.string(),
        topic: z.string(),
        paths: z.array(z.string()),
        description: z.string(),
        observedSha: z.string().optional()
      })
    )
    .optional()
});
type ParsedUpdate = NonNullable<z.infer<typeof mapUpdatesEnvelopeSchema>["mapUpdates"]>[number];

// Just the source ids off the job input, so updates can only touch sources the
// job was actually grounded in.
const sourcesEnvelopeSchema = z.object({ sources: z.array(z.object({ id: z.string() })) });

// Applies a completed source-grounded job's mapUpdates to the source map:
// upsert by (sourceId, topic), then evict the oldest-updated entries beyond the
// per-source cap. Best-effort throughout — this runs inside the completion
// side-effect fan-out and must NEVER throw (a map problem is never worth a
// job's paid-for output). Idempotent, so completion replays are safe.
export async function applySourceMapUpdatesFromCompletedJob(
  ctx: AppContext,
  job: JobView,
  output: unknown
): Promise<void> {
  if (!SOURCE_GROUNDED_JOB_TYPES.has(job.type)) {
    return;
  }
  const envelope = mapUpdatesEnvelopeSchema.safeParse(output);
  const updates = envelope.success ? (envelope.data.mapUpdates ?? []) : [];
  if (updates.length === 0) {
    return;
  }
  const parsedInput = sourcesEnvelopeSchema.safeParse(job.input);
  const allowedSourceIds = new Set(parsedInput.success ? parsedInput.data.sources.map((s) => s.id) : []);

  if (updates.length > MAX_UPDATES_PER_JOB) {
    logger.warn(
      { jobId: job.id, jobType: job.type, dropped: updates.length - MAX_UPDATES_PER_JOB },
      "source map: dropping updates beyond the per-job cap"
    );
  }
  const touchedSources = new Set<string>();
  for (const update of updates.slice(0, MAX_UPDATES_PER_JOB)) {
    const reason = rejectReason(update, allowedSourceIds);
    if (reason) {
      logger.warn(
        {
          jobId: job.id,
          jobType: job.type,
          sourceId: update.sourceId,
          topic: update.topic.slice(0, MAX_TOPIC_LENGTH),
          reason
        },
        "source map: dropping malformed update"
      );
      continue;
    }
    try {
      await ctx.stores.sourceMap.upsert({
        sourceId: update.sourceId,
        // Mirror rejectReason's normalisation exactly: empty-string paths are
        // dropped so they can't reach the store and skew the consensus Jaccard
        // (a stray "" in the set inflates the union and depresses similarity).
        paths: update.paths.map((path) => path.trim()).filter(Boolean),
        topic: update.topic.trim(),
        description: update.description.trim(),
        ...(update.observedSha ? { observedSha: update.observedSha } : {})
      });
      touchedSources.add(update.sourceId);
    } catch (error) {
      logger.warn(
        { jobId: job.id, sourceId: update.sourceId, err: error instanceof Error ? error.message : String(error) },
        "source map: upsert failed"
      );
    }
  }
  for (const sourceId of touchedSources) {
    try {
      const evicted = await ctx.stores.sourceMap.pruneToLimit(sourceId, MAX_ENTRIES_PER_SOURCE);
      if (evicted > 0) {
        logger.info({ sourceId, evicted }, "source map: evicted oldest entries beyond the per-source cap");
      }
    } catch (error) {
      logger.warn(
        { sourceId, err: error instanceof Error ? error.message : String(error) },
        "source map: eviction failed"
      );
    }
  }
}

function rejectReason(update: ParsedUpdate, allowedSourceIds: Set<string>): string | undefined {
  if (!allowedSourceIds.has(update.sourceId)) {
    return "unknown_source";
  }
  const topic = update.topic.trim();
  if (topic.length === 0 || topic.length > MAX_TOPIC_LENGTH) {
    return "topic_out_of_bounds";
  }
  const paths = update.paths.map((path) => path.trim()).filter(Boolean);
  if (paths.length === 0 || paths.length > MAX_PATHS || paths.some((path) => path.length > MAX_PATH_LENGTH)) {
    return "paths_out_of_bounds";
  }
  const description = update.description.trim();
  if (description.length === 0 || description.length > MAX_DESCRIPTION_LENGTH) {
    return "description_out_of_bounds";
  }
  return undefined;
}
