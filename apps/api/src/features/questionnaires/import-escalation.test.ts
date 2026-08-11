import { test } from "node:test";
import assert from "node:assert/strict";
import type { QuestionnaireItem } from "@magpie/core";
import { makeTestContext } from "../../test-support/context.js";
import { escalateImports, MAX_ESCALATIONS_PER_TICK, routeImportFindings } from "./import-escalation.js";
import { createQuestionnaire } from "./service.js";

function flowContext(): ReturnType<typeof makeTestContext> {
  return makeTestContext({
    knowledgeConfig: {
      sources: [{ id: "src-1", name: "Compliance repo", kind: "git", url: "https://example.com/compliance.git" }],
      destinations: [{ id: "docs", name: "Docs", kind: "local", path: "docs" }],
      flows: [{ id: "security", name: "Security", sourceIds: ["src-1"], destinationId: "docs" }],
      repositories: [],
      roleGrants: {},
      checkoutRoot: ".magpie/checkouts"
    }
  });
}

type Ctx = ReturnType<typeof flowContext>;

// Builds an imported questionnaire whose items already carry the given stage-1
// verdicts, which is the state escalation reads.
async function importedWithVerdicts(
  ctx: Ctx,
  verdicts: Array<"confirmed" | "divergent" | "uncovered">
): Promise<{ questionnaireId: string; items: QuestionnaireItem[] }> {
  const created = await createQuestionnaire(ctx, {
    name: "SIG 2025",
    flowId: "security",
    importOrigin: "sig.xlsx",
    questions: verdicts.map((verdict, index) => ({
      question: `q${index} (${verdict})`,
      importedAnswer: `imported answer ${index}`
    }))
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  for (const [index, verdict] of verdicts.entries()) {
    await ctx.stores.questionnaires.setImportVerdict(created.questionnaire.items[index].id, verdict);
  }
  return { questionnaireId: created.questionnaire.id, items: created.questionnaire.items };
}

async function stageTwoJobs(ctx: Ctx) {
  const { jobs } = await ctx.jobs.list({ type: "verify_imported_answer" });
  return jobs;
}

test("only divergent and uncovered items escalate", async () => {
  const ctx = flowContext();
  const { questionnaireId } = await importedWithVerdicts(ctx, ["confirmed", "divergent", "uncovered"]);

  const result = await escalateImports(ctx, questionnaireId);
  assert.equal(result.enqueued, 2);
  assert.equal(result.deferred, 0);

  const jobs = await stageTwoJobs(ctx);
  assert.equal(jobs.length, 2);
  // The sources the flow is configured with reach the job, or the agent would
  // judge claims with nothing to read.
  assert.equal((jobs[0].input as { sources: unknown[] }).sources.length, 1);
});

test("a divergent item carries Magpie's answer; an uncovered one deliberately does not", async () => {
  const ctx = flowContext();
  const { questionnaireId, items } = await importedWithVerdicts(ctx, ["divergent", "uncovered"]);
  await ctx.stores.questionnaires.setAnswerText(items[0].id, "Magpie says 2022.");
  await ctx.stores.questionnaires.setAnswerText(items[1].id, "should not be sent");
  await ctx.stores.questionnaires.setImportVerdict(items[0].id, "divergent");
  await ctx.stores.questionnaires.setImportVerdict(items[1].id, "uncovered");

  await escalateImports(ctx, questionnaireId);
  const jobs = await stageTwoJobs(ctx);
  const byItem = new Map(
    jobs.map((job) => [(job.input as { itemId: string }).itemId, job.input as { kbAnswer?: string }])
  );
  assert.equal(byItem.get(items[0].id)?.kbAnswer, "Magpie says 2022.");
  // "uncovered" means the KB produced nothing; sending text would assert
  // something the stage-1 compare never concluded.
  assert.equal(byItem.get(items[1].id)?.kbAnswer, undefined);
});

test("a large import defers beyond the per-tick cap rather than fanning out", async () => {
  const ctx = flowContext();
  const count = MAX_ESCALATIONS_PER_TICK + 5;
  const { questionnaireId } = await importedWithVerdicts(
    ctx,
    Array.from({ length: count }, () => "uncovered" as const)
  );

  const first = await escalateImports(ctx, questionnaireId);
  assert.equal(first.enqueued, MAX_ESCALATIONS_PER_TICK);
  assert.ok(first.deferred > 0, "the remainder must be reported as deferred, not dropped");

  // The next tick drains the rest — nothing is lost.
  const second = await escalateImports(ctx, questionnaireId);
  assert.equal(second.enqueued, 5);
  assert.equal(second.deferred, 0);
  assert.equal((await stageTwoJobs(ctx)).length, count);
});

test("a resumed tick never re-enqueues an item already escalated", async () => {
  const ctx = flowContext();
  const { questionnaireId } = await importedWithVerdicts(ctx, ["divergent", "uncovered"]);
  await escalateImports(ctx, questionnaireId);
  const again = await escalateImports(ctx, questionnaireId);
  assert.equal(again.enqueued, 0);
  assert.equal((await stageTwoJobs(ctx)).length, 2);
});

test("escalation stamps the item without falsifying its stage-1 verdict", async () => {
  const ctx = flowContext();
  const { questionnaireId, items } = await importedWithVerdicts(ctx, ["divergent"]);
  await escalateImports(ctx, questionnaireId);
  const item = await ctx.stores.questionnaires.itemById(items[0].id);
  assert.ok(item?.importEscalatedAt, "escalation must be stamped");
  assert.equal(item?.importVerdict, "divergent", "the worksheet must still report what stage 1 decided");
});

test("a documented-elsewhere finding raises an 'import' gap and opens no register entry", async () => {
  const ctx = flowContext();
  const { items } = await importedWithVerdicts(ctx, ["uncovered"]);
  const item = await ctx.stores.questionnaires.itemById(items[0].id);
  assert.ok(item?.questionLogId);

  await routeImportFindings(ctx, item!, "security", [
    { kind: "documented-elsewhere", claim: "We encrypt at rest with AES-256.", positions: [] }
  ]);

  const log = await ctx.stores.questionLogs.get(item!.questionLogId!);
  const gaps = (log?.gaps ?? []).filter((gap) => gap.source === "import");
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].summary, "We encrypt at rest with AES-256.");
  assert.equal((await ctx.stores.assertedClaims.list({ limit: 10 })).length, 0);
});

test("raising the same import gap twice is idempotent", async () => {
  const ctx = flowContext();
  const { items } = await importedWithVerdicts(ctx, ["uncovered"]);
  const item = await ctx.stores.questionnaires.itemById(items[0].id);
  const finding = { kind: "documented-elsewhere" as const, claim: "We encrypt at rest.", positions: [] };

  await routeImportFindings(ctx, item!, "security", [finding]);
  await routeImportFindings(ctx, item!, "security", [finding]);

  const log = await ctx.stores.questionLogs.get(item!.questionLogId!);
  assert.equal((log?.gaps ?? []).filter((gap) => gap.source === "import").length, 1);
});

test("unsubstantiated and contradicted findings open register entries of the right kind", async () => {
  const ctx = flowContext();
  const { items } = await importedWithVerdicts(ctx, ["uncovered"]);
  const item = await ctx.stores.questionnaires.itemById(items[0].id);

  await routeImportFindings(ctx, item!, "security", [
    { kind: "unsubstantiated", claim: "We hold ISO 27001.", positions: [] },
    {
      kind: "contradicted",
      claim: "Logs are retained for 1 year.",
      positions: [{ sourceId: "src-1", path: "retention.md", statement: "retained for 60 days" }]
    }
  ]);

  const open = await ctx.stores.assertedClaims.list({ status: "open", limit: 10 });
  assert.deepEqual(open.map((claim) => claim.kind).sort(), ["contradicted", "unsubstantiated"]);
  assert.ok(open.every((claim) => claim.itemId === item!.id));
});

test("a source-conflict finding routes to the conflict register, not the asserted-claims one", async () => {
  // Magpie never adjudicates between two sources, so this is not a claim we made
  // wrongly — it is a disagreement for humans to fix at the source.
  const ctx = flowContext();
  const { items } = await importedWithVerdicts(ctx, ["uncovered"]);
  const item = await ctx.stores.questionnaires.itemById(items[0].id);

  await routeImportFindings(ctx, item!, "security", [
    {
      kind: "source-conflict",
      claim: "Retention period.",
      positions: [
        { sourceId: "src-1", path: "policy.md", statement: "1 year" },
        { sourceId: "src-1", path: "ingest.ts", statement: "60 days" }
      ]
    }
  ]);

  assert.equal((await ctx.stores.assertedClaims.list({ limit: 10 })).length, 0);
  assert.equal((await ctx.stores.sourceConflicts.list({ status: "open", limit: 10 })).length, 1);
});

test("a mixed finding set fans out to all three destinations in one pass", async () => {
  const ctx = flowContext();
  const { items } = await importedWithVerdicts(ctx, ["uncovered"]);
  const item = await ctx.stores.questionnaires.itemById(items[0].id);

  await routeImportFindings(ctx, item!, "security", [
    { kind: "documented-elsewhere", claim: "We encrypt at rest.", positions: [] },
    { kind: "unsubstantiated", claim: "We hold ISO 27001.", positions: [] },
    {
      kind: "source-conflict",
      claim: "Retention.",
      positions: [
        { sourceId: "src-1", path: "a.md", statement: "1 year" },
        { sourceId: "src-1", path: "b.ts", statement: "60 days" }
      ]
    }
  ]);

  const log = await ctx.stores.questionLogs.get(item!.questionLogId!);
  assert.equal((log?.gaps ?? []).filter((gap) => gap.source === "import").length, 1);
  assert.equal((await ctx.stores.assertedClaims.list({ limit: 10 })).length, 1);
  assert.equal((await ctx.stores.sourceConflicts.list({ status: "open", limit: 10 })).length, 1);
});
