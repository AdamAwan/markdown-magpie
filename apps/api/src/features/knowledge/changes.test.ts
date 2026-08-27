import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import type { Principal } from "@magpie/auth";
import type { KnowledgeChange } from "@magpie/core";
import { buildApp } from "../../app.js";
import type { AppContext } from "../../context.js";
import { onError } from "../../http/errors.js";
import { makeTestContext } from "../../test-support/context.js";
import type { KnowledgeChangeRecord } from "../../stores/knowledge-change-store.js";
import { knowledgeRoutes } from "./routes.js";
import { parseChangeQuery } from "./changes.js";
import type { KnowledgeChangesReport } from "./changes.js";

// GET /api/knowledge/changes — the read surface over the knowledge change log
// (spec 2026-08-27-knowledge-change-log, rollout step 3).

function entry(overrides: Partial<KnowledgeChangeRecord> = {}): KnowledgeChangeRecord {
  return {
    repositoryId: "billing-kb",
    documentId: "billing-kb:rates.md",
    path: "rates.md",
    anchor: "tiers",
    heading: "Rate tiers",
    kind: "section_changed",
    cause: "external",
    flowId: "billing",
    ...overrides
  };
}

// Distinct commit shas keep the dedupe key apart, so each seeded entry is its own
// row rather than a replay of the previous one.
async function seed(ctx: AppContext): Promise<void> {
  await ctx.stores.knowledgeChanges.record([
    entry({ commitSha: "c1", summary: "Rate tiers rewritten", cause: "gap", proposalId: "p-1" }),
    entry({
      commitSha: "c2",
      anchor: "limits",
      heading: "Limits",
      kind: "section_added",
      cause: "source_sync",
      sourceId: "product-repo",
      sourceFromSha: "a1b2f3",
      sourceToSha: "c3d4e5",
      jobId: "job-1"
    }),
    entry({
      commitSha: "c3",
      documentId: "support-kb:faq.md",
      repositoryId: "support-kb",
      path: "faq.md",
      anchor: "refunds",
      heading: "Refunds",
      cause: "patrol",
      flowId: "support"
    })
  ]);
}

function twoFlowCtx(): AppContext {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [
    { id: "billing", name: "Billing", sourceIds: ["product-repo"], destinationId: "billing-kb" },
    { id: "support", name: "Support", sourceIds: [], destinationId: "support-kb" }
  ];
  return ctx;
}

async function get(ctx: AppContext, query: string): Promise<{ status: number; body: KnowledgeChangesReport }> {
  const res = await buildApp(ctx).request(`/api/knowledge/changes${query}`);
  return { status: res.status, body: (await res.json()) as KnowledgeChangesReport };
}

function paths(report: KnowledgeChangesReport): string[] {
  return report.changes.map((change: KnowledgeChange) => `${change.path}#${change.anchor ?? ""}`);
}

describe("parseChangeQuery", () => {
  it("rejects an unknown cause or kind rather than ignoring it", () => {
    assert.deepEqual(parseChangeQuery({ cause: "vibes" }), { ok: false, code: "invalid_cause" });
    assert.deepEqual(parseChangeQuery({ kind: "section_rewritten" }), { ok: false, code: "invalid_kind" });
  });

  it("rejects an unparseable instant rather than widening the window", () => {
    assert.deepEqual(parseChangeQuery({ since: "last tuesday" }), { ok: false, code: "invalid_since" });
    assert.deepEqual(parseChangeQuery({ until: "" }).ok, true, "an empty value is simply no filter");
  });

  it("normalizes a date-only bound to an ISO instant", () => {
    const parsed = parseChangeQuery({ since: "2026-08-01" });
    assert.equal(parsed.ok && parsed.query.since, "2026-08-01T00:00:00.000Z");
  });
});

describe("GET /api/knowledge/changes", () => {
  it("returns entries newest first with the summary over the same window", async () => {
    const ctx = twoFlowCtx();
    await seed(ctx);

    const { status, body } = await get(ctx, "");

    assert.equal(status, 200);
    assert.deepEqual(paths(body), ["faq.md#refunds", "rates.md#limits", "rates.md#tiers"]);
    assert.equal(body.summary.total, 3);
    assert.equal(body.summary.documentsTouched, 2);
    assert.equal(body.summary.byKind.section_changed, 2);
    assert.equal(body.summary.byKind.section_added, 1);
    assert.equal(body.summary.byCause.gap, 1);
    assert.equal(body.summary.byCause.patrol, 1);
    assert.equal(body.limit, 50);
  });

  it("narrows by each filter", async () => {
    const ctx = twoFlowCtx();
    await seed(ctx);

    assert.deepEqual(paths((await get(ctx, "?flowId=support")).body), ["faq.md#refunds"]);
    assert.deepEqual(paths((await get(ctx, "?documentId=billing-kb%3Arates.md")).body), [
      "rates.md#limits",
      "rates.md#tiers"
    ]);
    assert.deepEqual(paths((await get(ctx, "?sourceId=product-repo")).body), ["rates.md#limits"]);
    assert.deepEqual(paths((await get(ctx, "?cause=gap")).body), ["rates.md#tiers"]);
    assert.deepEqual(paths((await get(ctx, "?kind=section_added")).body), ["rates.md#limits"]);
  });

  it("composes filters, and the summary counts the filtered window rather than the table", async () => {
    const ctx = twoFlowCtx();
    await seed(ctx);

    const { body } = await get(ctx, "?flowId=billing&kind=section_changed");

    assert.deepEqual(paths(body), ["rates.md#tiers"]);
    assert.equal(body.summary.total, 1, "the summary describes the filtered window, not the whole log");
    assert.equal(body.summary.documentsTouched, 1);
    assert.equal(body.summary.byCause.patrol, 0, "the support flow's entry is outside this window");
    assert.equal(body.summary.byKind.section_added, 0);
  });

  it("still reports the log's start instant when the window is empty", async () => {
    const ctx = twoFlowCtx();
    await seed(ctx);
    const oldest = (await ctx.stores.knowledgeChanges.list({ limit: 10, offset: 0 })).at(-1)!.changedAt;

    // A window entirely in the future: nothing matches, but the log exists.
    const { body } = await get(ctx, "?since=2099-01-01");

    assert.deepEqual(body.changes, []);
    assert.equal(body.summary.total, 0);
    assert.equal(
      body.summary.logStartedAt,
      oldest,
      "an empty window must read as 'nothing recorded yet', not 'nothing changed'"
    );
  });

  it("reports no start instant when the log has never recorded anything", async () => {
    const { body } = await get(twoFlowCtx(), "");

    assert.deepEqual(body.changes, []);
    assert.equal(body.summary.logStartedAt, undefined);
    assert.equal(body.summary.total, 0);
  });

  it("carries the causing commit range's file counts, capped total included", async () => {
    const ctx = twoFlowCtx();
    await seed(ctx);
    await ctx.stores.sourceSync.createRun({
      flowId: "billing",
      sourceId: "product-repo",
      trigger: "scheduled",
      status: "running",
      jobId: "job-1",
      fromSha: "a1b2f3",
      toSha: "c3d4e5",
      // More files than SOURCE_SYNC_MAX_CHANGED_FILES: the run recorded the true
      // total, and the surface must be able to say how many were examined.
      changedFileCount: 1_412,
      candidateCount: 3
    });

    const { body } = await get(ctx, "?cause=source_sync");

    assert.deepEqual(body.changes[0]?.upstream, { changedFileCount: 1_412, examinedFileCount: 1_000 });
  });

  it("rejects an invalid enum value with a 400", async () => {
    const ctx = twoFlowCtx();

    assert.equal((await get(ctx, "?cause=nonsense")).status, 400);
    assert.equal((await get(ctx, "?kind=nonsense")).status, 400);
    assert.equal((await get(ctx, "?since=whenever")).status, 400);
  });

  it("reports an unknown flow or document as not found", async () => {
    const ctx = twoFlowCtx();
    await seed(ctx);

    assert.equal((await get(ctx, "?flowId=nope")).status, 404);
    assert.equal((await get(ctx, "?documentId=billing-kb%3Aunknown.md")).status, 404);
  });
});

// Flow-scoped authorization, layered on the read:knowledge scope. Capability
// evaluation itself is unit-tested in auth/capabilities.test.ts.
describe("GET /api/knowledge/changes flow scoping", () => {
  function principal(roles: string[]): Principal {
    return { subject: "auth0|tester", scopes: ["read:knowledge"], roles, payload: {} };
  }

  function appFor(ctx: AppContext, who: Principal): Hono {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("authRequired", true);
      c.set("principal", who);
      await next();
    });
    app.route("/knowledge", knowledgeRoutes(ctx));
    app.onError(onError);
    return app;
  }

  function scopedCtx(): AppContext {
    const ctx = twoFlowCtx();
    ctx.knowledgeConfig.roleGrants = { "kb-billing-readers": { billing: ["read"] } };
    return ctx;
  }

  it("reads a document in another flow as 404, not 403", async () => {
    const ctx = scopedCtx();
    await seed(ctx);

    const res = await appFor(ctx, principal(["kb-billing-readers"])).request(
      "/knowledge/changes?documentId=support-kb%3Afaq.md"
    );

    assert.equal(res.status, 404, "a cross-flow document must not be distinguishable from a missing one");
    assert.deepEqual(await res.json(), { error: "document_not_found" });
  });

  it("reads a flow the caller cannot see as 404", async () => {
    const ctx = scopedCtx();
    await seed(ctx);

    const res = await appFor(ctx, principal(["kb-billing-readers"])).request("/knowledge/changes?flowId=support");

    assert.equal(res.status, 404);
  });

  it("restricts an unfiltered read to the flows the caller may read", async () => {
    const ctx = scopedCtx();
    await seed(ctx);

    const res = await appFor(ctx, principal(["kb-billing-readers"])).request("/knowledge/changes");
    const body = (await res.json()) as KnowledgeChangesReport;

    assert.deepEqual(paths(body), ["rates.md#limits", "rates.md#tiers"]);
    assert.equal(body.summary.total, 2, "the summary is scoped the same way the rows are");
  });
});
