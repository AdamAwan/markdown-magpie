import type { WatcherView } from "@magpie/core";
import type { AppContext } from "../../context.js";

// How long a watcher may stay silent before the Jobs screen treats it as gone.
// 15 minutes is generous relative to the watcher's busy-heartbeat cadence (~30s)
// and idle-claim cadence (~2s), so a live watcher never flickers off; a crashed
// one disappears within the window. Override with WATCHER_ACTIVE_WINDOW_MS.
const DEFAULT_ACTIVE_WINDOW_MS = 15 * 60 * 1000;

export async function listWatchers(ctx: AppContext): Promise<WatcherView[]> {
  return ctx.stores.watchers.list(activeWindowMs());
}

function activeWindowMs(): number {
  const parsed = Number.parseInt(process.env.WATCHER_ACTIVE_WINDOW_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ACTIVE_WINDOW_MS;
}
