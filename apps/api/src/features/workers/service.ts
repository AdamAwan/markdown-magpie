import type { WatcherView } from "@magpie/core";
import type { AppContext } from "../../context.js";

// How long a watcher may stay silent before the Jobs screen treats it as gone.
// The 15-minute default (in startup config) is generous relative to the watcher's
// busy-heartbeat cadence (~30s) and idle-claim cadence (~2s), so a live watcher
// never flickers off; a crashed one disappears within the window. Override with
// WATCHER_ACTIVE_WINDOW_MS.
export async function listWatchers(ctx: AppContext): Promise<WatcherView[]> {
  return ctx.stores.watchers.list(ctx.settings.watcher.activeWindowMs);
}
