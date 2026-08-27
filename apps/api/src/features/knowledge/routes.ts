import { Hono } from "hono";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { rateLimit } from "../../http/rate-limit.js";
import { parseLimit, parseOffset } from "../../platform/paths.js";
import { HttpError } from "../../http/errors.js";
import { readJsonBody } from "../../http/body.js";
import * as knowledgeService from "./service.js";
import { knowledgeRepositoryErrorCode } from "./service.js";
import { can } from "../../auth/capabilities.js";
import { parseChangeQuery } from "./changes.js";

export function knowledgeRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.post("/repositories/index", requireScopes("manage:knowledge"), rateLimit(ctx, "trigger"), async (c) => {
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

  app.get("/repositories", requireScopes("read:knowledge"), (c) => {
    const limit = parseLimit(c.req.query("limit") ?? null, 50);
    const offset = parseOffset(c.req.query("offset") ?? null);
    return c.json(knowledgeService.listRepositories(ctx, { limit, offset }));
  });

  app.get("/documents", requireScopes("read:knowledge"), (c) => {
    const limit = parseLimit(c.req.query("limit") ?? null, 50);
    const offset = parseOffset(c.req.query("offset") ?? null);
    return c.json(knowledgeService.listDocuments(ctx, { limit, offset }));
  });

  app.get("/stats", requireScopes("read:knowledge"), (c) => c.json(knowledgeService.stats(ctx)));

  // Citation-usage report — how often each section/document has been cited by an
  // answer, ranked least-used first by default so a knowledge-base trim has
  // evidence behind it. Read-only; nothing acts on these numbers.
  app.get("/citation-usage", requireScopes("read:knowledge"), async (c) => {
    const group = c.req.query("group") ?? "section";
    const sort = c.req.query("sort") ?? "least";
    if (group !== "section" && group !== "document") {
      throw new HttpError(400, "invalid_group");
    }
    if (sort !== "least" && sort !== "most" && sort !== "recent") {
      throw new HttpError(400, "invalid_sort");
    }

    return c.json(
      await knowledgeService.citationUsage(ctx, {
        group,
        sort,
        limit: parseLimit(c.req.query("limit") ?? null, 50),
        offset: parseOffset(c.req.query("offset") ?? null),
        ...(c.req.query("repositoryId") ? { repositoryId: c.req.query("repositoryId") } : {})
      })
    );
  });

  // The knowledge change log — what changed in the destination knowledge base,
  // when, and what caused it (spec 2026-08-27-knowledge-change-log). Filtered,
  // paginated, newest first, with an aggregate over the same window and the log's
  // start instant so an empty window reads as "nothing recorded yet". Read-only
  // metadata about the corpus; it never enters retrieval.
  app.get("/changes", requireScopes("read:knowledge"), async (c) => {
    const parsed = parseChangeQuery({
      flowId: c.req.query("flowId"),
      documentId: c.req.query("documentId"),
      sourceId: c.req.query("sourceId"),
      since: c.req.query("since"),
      until: c.req.query("until"),
      cause: c.req.query("cause"),
      kind: c.req.query("kind")
    });
    if (!parsed.ok) {
      throw new HttpError(400, parsed.code);
    }

    const { flowId, documentId } = parsed.query;
    // A flow the caller cannot read is reported as not-found rather than
    // forbidden, so other flows are not enumerable through this endpoint
    // (docs/authorization.md).
    if (
      flowId !== undefined &&
      (!ctx.knowledgeConfig.flows.some((flow) => flow.id === flowId) || !can(ctx, c, "read", flowId))
    ) {
      throw new HttpError(404, "flow_not_found");
    }

    if (documentId !== undefined) {
      // Same rule for a document: one in another flow — or one nothing has ever
      // recorded — is a 404, never a 403.
      const document = await knowledgeService.resolveDocumentFlow(ctx, documentId);
      if (!document.known || !can(ctx, c, "read", document.flowId)) {
        throw new HttpError(404, "document_not_found");
      }
    }

    // With no flow named, a role-scoped caller still only sees the flows it can
    // read. A caller that can read every configured flow is left unrestricted, so
    // entries belonging to no flow (a repository that is nobody's destination)
    // stay visible to it.
    const readable = ctx.knowledgeConfig.flows.filter((flow) => can(ctx, c, "read", flow.id)).map((flow) => flow.id);
    const flowIds =
      flowId !== undefined ? [flowId] : readable.length === ctx.knowledgeConfig.flows.length ? undefined : readable;

    return c.json(
      await knowledgeService.knowledgeChanges(ctx, {
        query: parsed.query,
        ...(flowIds ? { flowIds } : {}),
        limit: parseLimit(c.req.query("limit") ?? null, 50),
        offset: parseOffset(c.req.query("offset") ?? null)
      })
    );
  });

  app.get("/flows", requireScopes("read:knowledge"), (c) => c.json({ flows: knowledgeService.listFlows(ctx) }));

  app.get("/search", requireScopes("read:knowledge"), async (c) => {
    const query = c.req.query("q")?.trim();
    if (!query) {
      throw new HttpError(400, "query_required");
    }

    const ranked = await knowledgeService.search(ctx, query, parseLimit(c.req.query("limit") ?? null, 5));
    return c.json({ sections: ranked.map((result) => result.section), ranked });
  });

  app.get("/sections/:id", requireScopes("read:knowledge"), (c) => {
    const section = knowledgeService.getSection(ctx, c.req.param("id"));
    if (!section) {
      throw new HttpError(404, "section_not_found");
    }

    return c.json({ section });
  });

  return app;
}
