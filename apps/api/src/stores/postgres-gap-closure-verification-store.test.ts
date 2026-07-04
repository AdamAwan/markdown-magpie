import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { PostgresGapClosureVerificationStore } from "./gap-closure-verification-store.js";
import { PostgresProposalStore } from "./postgres-proposal-store.js";
import type { ProposalInput } from "./proposal-store.js";
import { makeTestPool } from "../test-support/db-pool.js";

// Integration tests for the Postgres-backed gap-closure-verification store,
// specifically the countPriorStillOpen retry-cap query (issue #152): it must
// dedupe by proposal (a job retry re-recording the same proposal's outcome
// costs 1, not N) and honor the `since` bound (rows at/before a resolved or
// dismissed timestamp don't count). Self-skips unless DATABASE_URL points at a
// migrated database, matching the other Postgres* store tests.
const databaseUrl = process.env.DATABASE_URL;

function draft(title: string): ProposalInput {
  return {
    title,
    targetPath: `docs/${title}.md`,
    markdown: `# ${title}`,
    rationale: "because",
    evidence: []
  };
}

describe("PostgresGapClosureVerificationStore", { skip: databaseUrl ? false : "DATABASE_URL not set" }, () => {
  const pool = makeTestPool(databaseUrl as string);
  const proposals = new PostgresProposalStore(pool);
  const store = new PostgresGapClosureVerificationStore(pool);

  // Backdates a recorded row's created_at directly (row is looked up by its
  // proposal+question, unique enough within one test's own fixtures) so tests
  // can construct a deterministic ordering without relying on real-time sleeps.
  async function backdate(proposalId: string, questionId: string, createdAt: string): Promise<void> {
    await pool.query(
      "UPDATE gap_closure_verification SET created_at = $3 WHERE proposal_id = $1 AND question_id = $2",
      [proposalId, questionId, createdAt]
    );
  }

  it("counts distinct proposals, not raw rows: a same-proposal retry costs 1 toward the cap", async () => {
    const proposal = await proposals.create(draft(`retry-${randomUUID()}`));
    const questionId = randomUUID();

    // Simulate verify_gap_closure's job retry re-recording the same proposal's
    // still_open outcome twice (no idempotency guard on the job itself).
    await store.record({
      proposalId: proposal.id,
      questionId,
      verdict: "still_open",
      confidence: "low",
      citedMergedDoc: false
    });
    await store.record({
      proposalId: proposal.id,
      questionId,
      verdict: "still_open",
      confidence: "low",
      citedMergedDoc: false
    });

    assert.equal(await store.countPriorStillOpen(questionId), 1);
  });

  it("counts one failure per distinct proposal that failed to close the question", async () => {
    const first = await proposals.create(draft(`distinct-a-${randomUUID()}`));
    const second = await proposals.create(draft(`distinct-b-${randomUUID()}`));
    const questionId = randomUUID();

    await store.record({
      proposalId: first.id,
      questionId,
      verdict: "still_open",
      confidence: "low",
      citedMergedDoc: false
    });
    await store.record({
      proposalId: second.id,
      questionId,
      verdict: "still_open",
      confidence: "low",
      citedMergedDoc: false
    });

    assert.equal(await store.countPriorStillOpen(questionId), 2);
  });

  it("excludes still_open rows recorded at or before the since boundary", async () => {
    const older = await proposals.create(draft(`since-older-${randomUUID()}`));
    const newer = await proposals.create(draft(`since-newer-${randomUUID()}`));
    const questionId = randomUUID();

    await store.record({
      proposalId: older.id,
      questionId,
      verdict: "still_open",
      confidence: "low",
      citedMergedDoc: false
    });
    await backdate(older.id, questionId, "2020-01-01T00:00:00Z");

    await store.record({
      proposalId: newer.id,
      questionId,
      verdict: "still_open",
      confidence: "low",
      citedMergedDoc: false
    });
    await backdate(newer.id, questionId, "2020-06-01T00:00:00Z");

    // Without a bound, both distinct proposals count.
    assert.equal(await store.countPriorStillOpen(questionId), 2);

    // A `since` between the two only counts the newer failure — modeling a
    // question whose earlier failure predates a human resolving/dismissing its
    // parked gap (the reset boundary sits between the two recorded outcomes).
    assert.equal(await store.countPriorStillOpen(questionId, "2020-03-01T00:00:00Z"), 1);

    // A `since` after both excludes everything (a brand-new lineage).
    assert.equal(await store.countPriorStillOpen(questionId, "2020-12-01T00:00:00Z"), 0);
  });

  it("does not count 'closed' verdicts toward the cap", async () => {
    const proposal = await proposals.create(draft(`closed-${randomUUID()}`));
    const questionId = randomUUID();

    await store.record({
      proposalId: proposal.id,
      questionId,
      verdict: "closed",
      confidence: "high",
      citedMergedDoc: true
    });

    assert.equal(await store.countPriorStillOpen(questionId), 0);
  });
});
