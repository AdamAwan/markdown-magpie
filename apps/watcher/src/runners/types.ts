import type { JobCapability, JobType, JobView } from "@magpie/jobs";

// A runner executes exactly one capability's worth of work. The watcher claims a
// job for a capability it advertises, then dispatches it to the matching runner.
// `run` receives an AbortSignal so a server-side cancellation (surfaced via a
// heartbeat) or a watcher shutdown can interrupt in-flight work promptly.
export interface JobRunner {
  readonly capability: JobCapability;
  supports(type: JobType): boolean;
  run(job: JobView, signal: AbortSignal): Promise<unknown>;
}
