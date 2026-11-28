import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnswerResult } from "@magpie/core";
import type { JobCapability } from "@magpie/jobs";
import { Pool } from "pg";
import type { AppContext } from "../context.js";
import { completeJob } from "../features/jobs/service.js";
import * as proposals from "../features/proposals/service.js";
import { PgBossJobBroker } from "../jobs/pg-boss-broker.js";
import { makeTestContext } from "../test-support/context.js";
import { reconcileGaps } from "./gap-reconciler.js";

// The point of the non-blocking orchestrators, proven against the real thing: ONE
// watcher — one claim loop, one job at a time — runs an orchestrator AND the
// follow-up AI jobs it enqueues, on a real pg-boss queue with the real Postgres
// advisory locks the continuations serialise on. Before, the orchestrator's
// callback blocked on the follow-up, so the lone watcher could never claim it.
//
// Gated behind RUN_PG_INTEGRATION so `npm test` stays DB-free. Run with:
//   RUN_PG_INTEGRATION=1 node scripts/test-db.mjs npm run test -w @magpie/api
const runIntegration = process.env.RUN_PG_INTEGRATION === "1";
const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/markdown_magpie";
const schema = `pgboss_nonblocking_${process.pid}`;

// Everything the single watcher can do: orchestrate, and run the provider jobs.
const SOLO_CAPABILITIES: JobCapability[] = ["maintenance", "codex"];

function citation(path: string): AnswerResult["citations"][number] {
  return { documentId: "d", sectionId: "s", path, heading: "h", anchor: "a", excerpt: "e", relevance: 0.9 };
}

async function mergedProposal(ctx: AppContext, questions: string[]) {
  const logs = [];
  for (const question of questions) {
    const log = await ctx.stores.questionLogs.record({ question, chatProvider: "codex", retrievedSectionIds: [] });
    await ctx.stores.questionLogs.recordManualGap(log.id, `gap: ${question}`);
    logs.push(log);
  }
  const proposal = await ctx.stores.proposals.create({
    title: "Configure X",
    targetPath: "configure-x.md",
    markdown: "# Configure X\nbody",
    rationale: "r",
    evidence: [],
    gapSummary: questions.map((question) => `gap: ${question}`).join("\n"),
    triggeringQuestionIds: logs.map((log) => log.id)
  });
  await ctx.stores.proposals.updateStatus(proposal.id, "merged");
  const merged = await ctx.stores.proposals.get(proposal.id);
  assert.ok(merged);
  return { logs, merged };
}

test(
  "one watcher runs the orchestrators and their follow-ups on real pg-boss",
  { skip: !runIntegration },
  async (t) => {
    const pool = new Pool({ connectionString: databaseUrl });
    const broker = new PgBossJobBroker({ connectionString: databaseUrl, pool, schema });
    const closing: AnswerResult = {
      answer: "Set the X flag.",
      confidence: "high",
      citations: [citation("configure-x.md")]
    };

    t.before(() => broker.start());
    t.beforeEach(() => broker.reset());
    t.after(async () => {
      await broker.reset();
      await broker.stop();
      try {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await pool.end();
      }
    });

    await t.test("verify_gap_closure: the watcher that orchestrated goes on to answer its own re-ask", async () => {
      const ctx = makeTestContext({ jobs: broker, pool });
      const { logs, merged } = await mergedProposal(ctx, ["How do I configure X?"]);
      await ctx.jobs.create("verify_gap_closure", { proposalId: merged.id });

      // The lone watcher claims the orchestrator and makes its callback, which
      // returns at once instead of holding the watcher until the re-ask is answered.
      const orchestrator = await ctx.jobs.claim("solo", SOLO_CAPABILITIES);
      assert.equal(orchestrator?.type, "verify_gap_closure");
      const result = await proposals.verifyGapClosure(ctx, merged);
      assert.equal(result.closureStatus, "pending");
      assert.equal((await completeJob(ctx, orchestrator!.id, result, "solo")).ok, true);

      // Free again, the SAME watcher claims the re-ask it just caused, and completes it.
      const reask = await ctx.jobs.claim("solo", SOLO_CAPABILITIES);
      assert.equal(reask?.type, "answer_question");
      assert.equal((await completeJob(ctx, reask!.id, closing, "solo")).ok, true);

      assert.equal((await ctx.stores.proposals.get(merged.id))?.closureStatus, "verified_closed");
      assert.equal(await ctx.stores.gapClosureVerifications.countPriorStillOpen(logs[0]!.id), 0);
      assert.equal(await ctx.jobs.claim("solo", SOLO_CAPABILITIES), undefined, "nothing is left queued");
    });

    await t.test("two re-asks completing at the same instant commit exactly once (real advisory lock)", async () => {
      const ctx = makeTestContext({ jobs: broker, pool });
      const { logs, merged } = await mergedProposal(ctx, ["How do I configure X?", "How do I configure Y?"]);
      assert.equal((await proposals.verifyGapClosure(ctx, merged)).closureStatus, "pending");

      // Two watchers, each holding one of the re-asks, complete concurrently. Both
      // continuations see "every question answered"; the per-proposal lock and the
      // entry guard re-read under it let only one commit.
      const first = await ctx.jobs.claim("w1", SOLO_CAPABILITIES);
      const second = await ctx.jobs.claim("w2", SOLO_CAPABILITIES);
      assert.ok(first && second);
      // Neither answer closes its gap, so each question records a still_open — the
      // verdict a double commit would count twice against the retry cap.
      const unsure: AnswerResult = { answer: "Not sure.", confidence: "low", citations: [] };
      const [a, b] = await Promise.all([
        completeJob(ctx, first.id, unsure, "w1"),
        completeJob(ctx, second.id, unsure, "w2")
      ]);
      assert.equal(a.ok, true);
      assert.equal(b.ok, true);

      assert.equal((await ctx.stores.proposals.get(merged.id))?.closureStatus, "reopened");
      for (const log of logs) {
        assert.equal(
          await ctx.stores.gapClosureVerifications.countPriorStillOpen(log.id),
          1,
          "one still_open per question — the second continuation recorded nothing"
        );
      }
    });

    await t.test(
      "process_gaps_to_pull_requests: the reshape's completion applies the verdicts and drafts",
      async () => {
        const ctx = makeTestContext({ jobs: broker, pool });
        for (const summary of ["Cheese", "Cats"]) {
          const log = await ctx.stores.questionLogs.record({
            question: `${summary}?`,
            chatProvider: "codex",
            retrievedSectionIds: []
          });
          await ctx.stores.questionLogs.recordManualGap(log.id, summary);
        }
        const deps = {
          fetchPullRequestStatus: async () => undefined,
          publishProposal: async () => {},
          supersedeProposal: async () => {}
        };

        // The orchestrator's callback: clusters, enqueues the reshape, returns.
        await reconcileGaps(ctx, undefined, deps);
        assert.equal((await ctx.jobs.list({ type: "draft_markdown_proposal" })).jobs.length, 0);

        // The same watcher claims the reshape and completes it: merge the two clusters.
        const reshape = await ctx.jobs.claim("solo", SOLO_CAPABILITIES);
        assert.equal(reshape?.type, "reconcile_gap_clusters");
        const clusterIds = (reshape!.input as { clusters: Array<{ id: string }> }).clusters.map((c) => c.id);
        const completion = await completeJob(
          ctx,
          reshape!.id,
          { merges: [{ clusterIds, rationale: "same topic", confirmed: true }], splits: [], dismissals: [] },
          "solo"
        );
        assert.equal(completion.ok, true);

        assert.equal((await ctx.stores.gapClusters.listActiveClusters()).length, 1, "the merge was applied");
        assert.equal(
          (await ctx.jobs.list({ type: "draft_markdown_proposal" })).jobs.length,
          1,
          "the continuation drafted the merged cluster"
        );
        assert.equal(
          await ctx.stores.gapClusters.getProcessedRevision(undefined),
          await ctx.stores.questionLogs.getGapCatalogRevision(undefined)
        );
      }
    );
  }
);
