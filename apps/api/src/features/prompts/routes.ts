import { Hono } from "hono";
import { promptCatalog } from "@magpie/prompts";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";

// No service.ts: this feature serves a static, build-time catalog (`promptCatalog`
// from @magpie/prompts) verbatim — it reads no stores, touches no context, and runs
// no logic. A service layer here would be a one-line re-export, so the route stays
// flat by design rather than for lack of consistency with the routes→service→schema
// features.
export function promptRoutes(_ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/", requireScopes("read:knowledge"), (c) => c.json({ prompts: promptCatalog }));

  return app;
}
