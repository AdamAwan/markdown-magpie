import type { WatcherView } from "@magpie/core";
import { jobTypesWithoutCapabilities, type JobType } from "@magpie/jobs";
import type { AppContext } from "../../context.js";

// How long a watcher may stay silent before the Jobs screen treats it as gone.
// The 15-minute default (in startup config) is generous relative to the watcher's
// busy-heartbeat cadence (~30s) and idle-claim cadence (~2s), so a live watcher
// never flickers off; a crashed one disappears within the window. Override with
// WATCHER_ACTIVE_WINDOW_MS.
export async function listWatchers(ctx: AppContext): Promise<WatcherView[]> {
  return ctx.stores.watchers.list(ctx.settings.watcher.activeWindowMs);
}

// The job types no currently-active watcher can execute — the fleet's coverage
// gap, which drives the console's "no watcher can run these jobs" banner. A job
// type is covered when ANY active watcher advertises a capability that can run it
// (so publish_proposal is covered by a github OR a local-git watcher). Computed
// here, on the server, so the browser never has to bundle the job catalog.
export function uncoveredJobTypes(watchers: readonly WatcherView[]): JobType[] {
  return jobTypesWithoutCapabilities(watchers.flatMap((watcher) => watcher.capabilities));
}
