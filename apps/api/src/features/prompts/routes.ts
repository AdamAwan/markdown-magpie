import { Hono } from "hono";
import { promptCatalog } from "@magpie/prompts";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";

export function promptRoutes(_ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/", requireScopes("read:knowledge"), (c) => c.json({ prompts: promptCatalog }));

  return app;
}
