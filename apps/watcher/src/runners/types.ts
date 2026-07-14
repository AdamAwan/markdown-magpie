import type { AiUsage } from "@magpie/core";
import type { JobCapability, JobType, JobView } from "@magpie/jobs";

// A runner executes exactly one capability's worth of work. The watcher claims a
// job for a capability it advertises, then dispatches it to the matching runner.
// `run` receives an AbortSignal so a server-side cancellation (surfaced via a
// heartbeat) or a watcher shutdown can interrupt in-flight work promptly.
// `onUsage`, when supplied, receives each provider-reported token-usage reading
// as the run makes model calls (#241); the worker loop sums the readings and
// attaches the total to the job's completion. Runners whose provider reports
// no usage (CLI agents, non-AI work) simply never call it.
export interface JobRunner {
  readonly capability: JobCapability;
  supports(type: JobType): boolean;
  run(job: JobView, signal: AbortSignal, onUsage?: (usage: AiUsage) => void): Promise<unknown>;
}
