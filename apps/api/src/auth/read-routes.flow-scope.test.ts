import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import type { Principal } from "@magpie/auth";
import type { AppContext } from "../context.js";
import { onError } from "../http/errors.js";
import { makeTestContext } from "../test-support/context.js";
import { jobRoutes } from "../features/jobs/routes.js";
import { knowledgeRoutes } from "../features/knowledge/routes.js";
import { questionRoutes } from "../features/questions/routes.js";
import { snapshotRoutes } from "../features/snapshots/routes.js";

// docs/authorization.md AZ30–AZ34: the read:knowledge read routes apply the
// flow-scoped capabilities on top of their scope gate. Lists are filtered to the
// flows the caller may read, a single resource in another flow reads as 404 (not
// 403), and a flow-less resource needs a "*" grant. Jobs are the one deliberate
// exception: their content is REDACTED rather than hidden (AZ34).

const SCOPES = ["read:knowledge", "feedback:questions", "manage:jobs"];

function human(roles: string[] | undefined): Principal {
  return { subject: "auth0|tester", scopes: SCOPES, roles, isService: false, payload: {} };
}

function service(): Principal {
  return {
    subject: "svc@clients",
    scopes: SCOPES,
    roles: undefined,
    isService: true,
    payload: { gty: "client-credentials" }
  };
}

const HR_CURATOR = human(["kb-hr-curators"]);
const HR_ASKER = human(["kb-hr-askers"]);
const SUPER = human(["kb-super"]);
const NOBODY = human([]);

function twoFlowCtx(): AppContext {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [
    { id: "hr", name: "HR", sourceIds: [], destinationId: "hr-kb" },
    { id: "eng", name: "Eng", sourceIds: [], destinationId: "eng-kb" }
  ];
  ctx.knowledgeConfig.roleGrants = {
    "kb-hr-curators": { hr: ["read", "manage"] },
    "kb-hr-askers": { hr: ["ask"] },
    "kb-super": { "*": ["read", "manage", "ask"] }
  };
  return ctx;
}

function appFor(ctx: AppContext, who: Principal): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authRequired", true);
    c.set("principal", who);
    await next();
  });
  app.route("/jobs", jobRoutes(ctx));
  app.route("/knowledge", knowledgeRoutes(ctx));
  app.route("/questions", questionRoutes(ctx));
  app.route("/snapshots", snapshotRoutes(ctx));
  app.onError(onError);
  return app;
}

async function getJson<T>(app: Hono, path: string): Promise<{ status: number; body: T }> {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as T };
}

describe("snapshot routes flow scoping (AZ31)", () => {
  async function seeded(): Promise<AppContext> {
    const ctx = twoFlowCtx();
    for (const flowId of ["hr", "eng", undefined]) {
      await ctx.stores.snapshots.write({
        ...(flowId ? { flowId } : {}),
        takenAt: "2026-11-01T00:00:00.000Z",
        catalogRevision: 1,
        gaps: [],
        proposals: [],
        pullRequests: []
      });
    }
    return ctx;
  }

  it("lists only the readable flows' snapshots; the default flow needs a * grant", async () => {
    const ctx = await seeded();
    const scoped = await getJson<{ snapshots: Array<{ flowId?: string }> }>(appFor(ctx, HR_CURATOR), "/snapshots");
    assert.deepEqual(
      scoped.body.snapshots.map((snapshot) => snapshot.flowId),
      ["hr"]
    );
    const all = await getJson<{ snapshots: unknown[] }>(appFor(ctx, SUPER), "/snapshots");
    assert.equal(all.body.snapshots.length, 3);
    const svc = await getJson<{ snapshots: unknown[] }>(appFor(ctx, service()), "/snapshots");
    assert.equal(svc.body.snapshots.length, 3);
  });

  it("reads another flow's (or the default flow's) snapshot as 404", async () => {
    const ctx = await seeded();
    const app = appFor(ctx, HR_CURATOR);
    assert.equal((await app.request("/snapshots/hr")).status, 200);
    assert.equal((await app.request("/snapshots/eng")).status, 404);
    assert.equal((await app.request("/snapshots/default")).status, 404);
    assert.equal((await appFor(ctx, SUPER).request("/snapshots/default")).status, 200);
  });
});

describe("knowledge routes flow scoping (AZ32)", () => {
  async function seeded(): Promise<AppContext> {
    const ctx = twoFlowCtx();
    await ctx.stores.knowledgeIndex.indexMarkdownDocuments({
      documents: [{ path: "leave.md", content: "# Rollback policy\nRun the rollback workflow for HR.\n" }],
      repositoryId: "hr-kb"
    });
    await ctx.stores.knowledgeIndex.indexMarkdownDocuments({
      documents: [{ path: "deploy.md", content: "# Rollback policy\nRun the rollback workflow for Eng.\n" }],
      repositoryId: "eng-kb"
    });
    // A repository that is no flow's destination: flow-less, "*" only.
    await ctx.stores.knowledgeIndex.indexMarkdownDocuments({
      documents: [{ path: "misc.md", content: "# Rollback policy\nRun the rollback workflow anywhere.\n" }],
      repositoryId: "loose-kb"
    });
    return ctx;
  }

  function sectionIn(ctx: AppContext, repositoryId: string): string {
    const document = ctx.stores.knowledgeIndex.listDocuments().find((doc) => doc.repositoryId === repositoryId);
    const section = ctx.stores.knowledgeIndex.listSections().find((s) => s.documentId === document?.id);
    assert.ok(section, `a section indexed in ${repositoryId}`);
    return section.id;
  }

  it("filters documents (and their total) to the readable flows' destinations", async () => {
    const ctx = await seeded();
    const scoped = await getJson<{ documents: Array<{ repositoryId: string }>; total: number }>(
      appFor(ctx, HR_CURATOR),
      "/knowledge/documents"
    );
    assert.deepEqual(
      scoped.body.documents.map((doc) => doc.repositoryId),
      ["hr-kb"]
    );
    assert.equal(scoped.body.total, 1);

    const none = await getJson<{ documents: unknown[]; total: number }>(appFor(ctx, NOBODY), "/knowledge/documents");
    assert.deepEqual(none.body, { documents: [], total: 0 });

    const all = await getJson<{ total: number }>(appFor(ctx, SUPER), "/knowledge/documents");
    assert.equal(all.body.total, 3);
  });

  it("scopes search to readable flows; an ask grant also reads the indexed corpus", async () => {
    const ctx = await seeded();
    const repoOf = (id: string) =>
      ctx.stores.knowledgeIndex.getDocument(ctx.stores.knowledgeIndex.getSection(id)?.documentId ?? "")?.repositoryId;
    for (const who of [HR_CURATOR, HR_ASKER]) {
      const res = await getJson<{ sections: Array<{ id: string }> }>(appFor(ctx, who), "/knowledge/search?q=rollback");
      assert.equal(res.status, 200);
      assert.ok(res.body.sections.length > 0);
      assert.deepEqual([...new Set(res.body.sections.map((section) => repoOf(section.id)))], ["hr-kb"]);
    }
    // No readable flow means no results — never an unscoped search.
    const none = await getJson<{ sections: unknown[] }>(appFor(ctx, NOBODY), "/knowledge/search?q=rollback");
    assert.deepEqual(none.body.sections, []);
  });

  it("reads a section outside the readable flows as 404", async () => {
    const ctx = await seeded();
    const app = appFor(ctx, HR_CURATOR);
    assert.equal((await app.request(`/knowledge/sections/${sectionIn(ctx, "hr-kb")}`)).status, 200);
    assert.equal((await app.request(`/knowledge/sections/${sectionIn(ctx, "eng-kb")}`)).status, 404);
    assert.equal((await app.request(`/knowledge/sections/${sectionIn(ctx, "loose-kb")}`)).status, 404);
    assert.equal((await appFor(ctx, SUPER).request(`/knowledge/sections/${sectionIn(ctx, "loose-kb")}`)).status, 200);
  });

  it("limits the citation-usage report to the readable flows' documents", async () => {
    const ctx = await seeded();
    const res = await getJson<{ rows: Array<{ path: string }> }>(
      appFor(ctx, HR_CURATOR),
      "/knowledge/citation-usage?limit=200"
    );
    assert.equal(res.status, 200);
    assert.deepEqual([...new Set(res.body.rows.map((row) => row.path))], ["leave.md"]);
  });
});

describe("question routes flow scoping (AZ33)", () => {
  async function seeded(): Promise<{ ctx: AppContext; hr: string; eng: string; unrouted: string }> {
    const ctx = twoFlowCtx();
    const record = async (question: string, flowId?: string) =>
      (
        await ctx.stores.questionLogs.record({
          question,
          chatProvider: "codex",
          retrievedSectionIds: [],
          ...(flowId ? { flowId } : {})
        })
      ).id;
    return {
      ctx,
      hr: await record("HR question?", "hr"),
      eng: await record("Eng question?", "eng"),
      unrouted: await record("Unrouted question?")
    };
  }

  it("filters the list and both totals to readable flows", async () => {
    const { ctx, hr } = await seeded();
    const scoped = await getJson<{ questions: Array<{ id: string }>; total: number; matching: number }>(
      appFor(ctx, HR_CURATOR),
      "/questions?q=question"
    );
    assert.deepEqual(
      scoped.body.questions.map((question) => question.id),
      [hr]
    );
    assert.equal(scoped.body.total, 1);
    assert.equal(scoped.body.matching, 1);

    const all = await getJson<{ total: number }>(appFor(ctx, SUPER), "/questions");
    assert.equal(all.body.total, 3);
    const none = await getJson<{ questions: unknown[]; total: number }>(appFor(ctx, NOBODY), "/questions");
    assert.equal(none.body.total, 0);
  });

  it("reads another flow's (or an unrouted) question as 404", async () => {
    const { ctx, hr, eng, unrouted } = await seeded();
    const app = appFor(ctx, HR_CURATOR);
    assert.equal((await app.request(`/questions/${hr}`)).status, 200);
    assert.equal((await app.request(`/questions/${eng}`)).status, 404);
    assert.equal((await app.request(`/questions/${unrouted}`)).status, 404);
  });

  it("lets an asker give feedback in its flow but 404s other flows' questions", async () => {
    const { ctx, hr, eng } = await seeded();
    const feedback = (id: string) =>
      appFor(ctx, HR_ASKER).request(`/questions/${id}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "helpful" })
      });
    assert.equal((await feedback(hr)).status, 200);
    assert.equal((await feedback(eng)).status, 404);
    const flag = await appFor(ctx, HR_CURATOR).request(`/questions/${eng}/gap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ summary: "missing" })
    });
    assert.equal(flag.status, 404);
  });

  it("filters parked questions to readable flows", async () => {
    const { ctx, hr, eng } = await seeded();
    for (const id of [hr, eng]) {
      await ctx.stores.questionLogs.recordVerificationGap(id, { summary: "still open", note: "n", parked: true });
    }
    const res = await getJson<{ questions: Array<{ questionId: string }> }>(
      appFor(ctx, HR_CURATOR),
      "/questions/parked"
    );
    assert.deepEqual(
      res.body.questions.map((question) => question.questionId),
      [hr]
    );
  });
});

describe("job read routes flow scoping (AZ34)", () => {
  async function seeded(): Promise<{ ctx: AppContext; hrDraft: string; engDraft: string; hrAnswer: string }> {
    const ctx = twoFlowCtx();
    const hrDraft = (await ctx.jobs.create("source_change_sync", { flowId: "hr" })).id;
    const engDraft = (await ctx.jobs.create("source_change_sync", { flowId: "eng" })).id;
    const hrAnswer = (
      await ctx.jobs.create("answer_question", {
        provider: "codex",
        question: "q?",
        flows: [],
        requestedFlowId: "hr",
        expectedOutput: "answer_result"
      })
    ).id;
    await ctx.jobs.complete(hrAnswer, { result: { answer: "a", flowId: "hr" }, executor: "w" });
    return { ctx, hrDraft, engDraft, hrAnswer };
  }

  interface JobBody {
    id: string;
    input: Record<string, unknown>;
    output?: unknown;
    redacted?: boolean;
  }

  it("shows a readable flow's job in full and redacts another flow's", async () => {
    const { ctx, hrDraft, engDraft } = await seeded();
    const app = appFor(ctx, HR_CURATOR);
    const own = await getJson<{ job: JobBody }>(app, `/jobs/${hrDraft}`);
    assert.equal(own.body.job.input.flowId, "hr");
    assert.equal(own.body.job.redacted, undefined);

    const other = await getJson<{ job: JobBody }>(app, `/jobs/${engDraft}`);
    assert.equal(other.status, 200);
    assert.deepEqual(other.body.job.input, {});
    assert.equal(other.body.job.redacted, true);
  });

  it("redacts list rows without dropping them, so the total stays exact", async () => {
    const { ctx } = await seeded();
    const res = await getJson<{ jobs: JobBody[]; total: number }>(appFor(ctx, NOBODY), "/jobs");
    assert.equal(res.body.total, 3);
    assert.equal(res.body.jobs.length, 3);
    assert.ok(res.body.jobs.every((job) => job.redacted === true && Object.keys(job.input).length === 0));
    assert.ok(res.body.jobs.every((job) => job.output === undefined));
  });

  it("lets an asker read (and wait on) its flow's answer job", async () => {
    const { ctx, hrAnswer, engDraft } = await seeded();
    const app = appFor(ctx, HR_ASKER);
    const waited = await getJson<{ job: JobBody }>(app, `/jobs/${hrAnswer}/wait`);
    assert.equal(waited.status, 200);
    assert.deepEqual(waited.body.job.output, { result: { answer: "a", flowId: "hr" }, executor: "w" });
    // An ask grant does not open non-answer jobs.
    const draft = await getJson<{ job: JobBody }>(app, `/jobs/${engDraft}`);
    assert.equal(draft.body.job.redacted, true);
  });

  it("shows every job in full to a service principal and a * reader", async () => {
    const { ctx, engDraft } = await seeded();
    for (const who of [service(), SUPER]) {
      const res = await getJson<{ job: JobBody }>(appFor(ctx, who), `/jobs/${engDraft}`);
      assert.equal(res.body.job.input.flowId, "eng");
    }
  });
});
