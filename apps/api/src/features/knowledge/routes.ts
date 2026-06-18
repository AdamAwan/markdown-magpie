import { Hono } from "hono";
import type { AppContext } from "../../context.js";
import { parseLimit } from "../../platform/paths.js";
import { HttpError } from "../../http/errors.js";
import { readJsonBody } from "../../http/body.js";
import * as knowledgeService from "./service.js";
import { knowledgeRepositoryErrorCode } from "./service.js";

export function knowledgeRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.post("/repositories/index", async (c) => {
    const payload = await readJsonBody<{
      flowId?: string;
      localPath?: string;
      repositoryId?: string;
      name?: string;
    }>(c);

    let selection: { localPath: string; repositoryId?: string; name?: string };
    try {
      selection = await knowledgeService.resolveSelection(ctx, payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : "configured_repository_required";
      throw new HttpError(400, knowledgeRepositoryErrorCode(message), message);
    }

    const summary = await knowledgeService.indexSelection(ctx, selection);
    return c.json(summary);
  });

  app.get("/repositories", (c) => c.json({ repositories: knowledgeService.listRepositories(ctx) }));

  app.get("/documents", (c) => c.json({ documents: knowledgeService.listDocuments(ctx) }));

  app.get("/stats", (c) => c.json(knowledgeService.stats(ctx)));

  app.get("/search", async (c) => {
    const query = c.req.query("q")?.trim();
    if (!query) {
      throw new HttpError(400, "query_required");
    }

    const ranked = await knowledgeService.search(ctx, query, parseLimit(c.req.query("limit") ?? null, 5));
    return c.json({ sections: ranked.map((result) => result.section), ranked });
  });

  return app;
}
