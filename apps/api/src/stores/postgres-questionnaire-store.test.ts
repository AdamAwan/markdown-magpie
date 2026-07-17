import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { QuestionnaireItemCitation } from "@magpie/core";
import { PostgresQuestionnaireStore } from "./postgres-questionnaire-store.js";
import { makeTestPool } from "../test-support/db-pool.js";

const databaseUrl = process.env.DATABASE_URL;

// A deterministic unit-ish embedding: all mass on one axis, so cosine
// similarity between equal vectors is 1 and between orthogonal vectors is 0.
function axisEmbedding(axis: number): number[] {
  const vector = new Array<number>(1536).fill(0);
  vector[axis] = 1;
  return vector;
}

function citation(sectionId: string): QuestionnaireItemCitation {
  return { sectionId, contentHash: `hash-${sectionId}`, path: "docs/a.md", heading: "A", excerpt: "…" };
}

describe("PostgresQuestionnaireStore", { skip: databaseUrl ? false : "DATABASE_URL not set" }, () => {
  const store = new PostgresQuestionnaireStore(makeTestPool(databaseUrl as string));

  it("creates a questionnaire with ordered pending items and round-trips it", async () => {
    const created = await store.create({
      name: `SIG ${randomUUID()}`,
      flowId: "flow-a",
      questions: ["What certs do you hold?", "Where is data stored?"]
    });
    assert.equal(created.items.length, 2);
    assert.deepEqual(
      created.items.map((item) => item.position),
      [0, 1]
    );

    const fetched = await store.get(created.id);
    assert.equal(fetched?.name, created.name);
    assert.equal(fetched?.status, "open");
    assert.deepEqual(
      fetched?.items.map((item) => item.status),
      ["pending", "pending"]
    );

    const summaries = await store.list();
    const summary = summaries.find((entry) => entry.id === created.id);
    assert.equal(summary?.counts.total, 2);
    assert.equal(summary?.counts.pending, 2);
  });

  it("drip bookkeeping: nextPending walks positions, countAnswering tracks in-flight", async () => {
    const created = await store.create({
      name: `drip ${randomUUID()}`,
      flowId: "flow-a",
      questions: ["q0", "q1", "q2"]
    });
    const first = await store.nextPending(created.id);
    assert.equal(first?.position, 0);

    await store.markAnswering(first!.id, `log-${randomUUID()}`);
    assert.equal(await store.countAnswering(created.id), 1);
    const second = await store.nextPending(created.id);
    assert.equal(second?.position, 1);

    const answering = await store.get(created.id);
    assert.equal(answering?.items[0].status, "answering");
    assert.equal(answering?.items[0].outcome, "fresh");
  });

  it("completes and fails items by question log id, storing citations", async () => {
    const created = await store.create({ name: `complete ${randomUUID()}`, flowId: "flow-a", questions: ["q0", "q1"] });
    const [first, second] = created.items;
    const firstLog = `log-${randomUUID()}`;
    const secondLog = `log-${randomUUID()}`;
    await store.markAnswering(first.id, firstLog);
    await store.markAnswering(second.id, secondLog);

    const answeredAt = new Date().toISOString();
    const completed = await store.completeItem(firstLog, {
      answer: "We hold ISO 27001.",
      answeredAt,
      citations: [citation("sec-1")],
      unanswerable: false,
      confidence: "high"
    });
    assert.equal(completed?.status, "answered");
    assert.equal(completed?.citations[0]?.sectionId, "sec-1");

    const failed = await store.failItem(secondLog, "provider exploded");
    assert.equal(failed?.status, "unanswerable");
    assert.equal(failed?.error, "provider exploded");

    const byLog = await store.itemByQuestionLogId(firstLog);
    assert.equal(byLog?.id, first.id);
    assert.equal(byLog?.citations.length, 1);
    assert.equal(await store.itemByQuestionLogId(`missing-${randomUUID()}`), undefined);
  });

  it("matches only approved same-model items in the same flow, above the caller's threshold", async () => {
    const flowId = `flow-${randomUUID()}`;
    const prior = await store.create({ name: `prior ${randomUUID()}`, flowId, questions: ["What certs do you hold?"] });
    const item = prior.items[0];
    const log = `log-${randomUUID()}`;
    await store.markAnswering(item.id, log);
    await store.completeItem(log, {
      answer: "ISO 27001 and SOC 2.",
      answeredAt: new Date().toISOString(),
      citations: [citation("sec-cert")],
      unanswerable: false,
      confidence: "high"
    });
    await store.setItemEmbeddings([{ itemId: item.id, embedding: axisEmbedding(3), model: "test-model" }]);

    // Not approved yet → no match.
    assert.equal(await store.matchApproved(flowId, axisEmbedding(3), "test-model"), undefined);

    await store.approveItem(item.id, [citation("sec-cert")], false);
    const match = await store.matchApproved(flowId, axisEmbedding(3), "test-model");
    assert.equal(match?.item.id, item.id);
    assert.ok((match?.similarity ?? 0) > 0.999);
    assert.equal(match?.item.citations[0]?.contentHash, "hash-sec-cert");

    // Different model or different flow → no match.
    assert.equal(await store.matchApproved(flowId, axisEmbedding(3), "other-model"), undefined);
    assert.equal(await store.matchApproved(`other-${flowId}`, axisEmbedding(3), "test-model"), undefined);
  });

  it("markReused carries the ORIGINAL answeredAt forward and markChanged records the reason", async () => {
    const flowId = `flow-${randomUUID()}`;
    const created = await store.create({ name: `reuse ${randomUUID()}`, flowId, questions: ["q0", "q1"] });
    const [reusedItem, changedItem] = created.items;

    const originalAnsweredAt = "2026-04-12T09:00:00.000Z";
    await store.markReused(reusedItem.id, {
      itemId: changedItem.id,
      answer: "Prior verbatim answer.",
      answeredAt: originalAnsweredAt
    });
    await store.markChanged(changedItem.id, {
      kind: "new_content",
      sectionId: "sec-new",
      path: "docs/certs/new.md",
      heading: "New Cert",
      changedAt: "2026-06-03T00:00:00.000Z"
    });

    const fetched = await store.get(created.id);
    const reused = fetched?.items.find((entry) => entry.id === reusedItem.id);
    assert.equal(reused?.outcome, "reused");
    assert.equal(reused?.status, "answered");
    assert.equal(reused?.answeredAt, originalAnsweredAt);
    assert.equal(reused?.reusedFromItemId, changedItem.id);

    const changed = fetched?.items.find((entry) => entry.id === changedItem.id);
    assert.equal(changed?.outcome, "changed");
    assert.equal(changed?.status, "pending", "a changed item stays pending for the drip");
    assert.equal(changed?.changeReason?.kind, "new_content");
    assert.equal(changed?.changeReason?.path, "docs/certs/new.md");

    const reusedUnapproved = await store.listReusedUnapproved(created.id);
    assert.deepEqual(
      reusedUnapproved.map((entry) => entry.id),
      [reusedItem.id]
    );
  });

  it("approval replaces citations and records stale-at-approval", async () => {
    const created = await store.create({ name: `approve ${randomUUID()}`, flowId: "flow-a", questions: ["q0"] });
    const item = created.items[0];
    const log = `log-${randomUUID()}`;
    await store.markAnswering(item.id, log);
    await store.completeItem(log, {
      answer: "answer",
      answeredAt: new Date().toISOString(),
      citations: [citation("sec-old")],
      unanswerable: false,
      confidence: "high"
    });

    await store.approveItem(item.id, [citation("sec-new")], true);
    const fetched = await store.get(created.id);
    assert.equal(fetched?.items[0].status, "approved");
    assert.equal(fetched?.items[0].staleAtApproval, true);
    assert.deepEqual(
      fetched?.items[0].citations.map((entry) => entry.sectionId),
      ["sec-new"]
    );
    assert.ok(fetched?.items[0].approvedAt);
  });

  it("matchApprovedTopN returns candidates ordered by similarity and respects limit", async () => {
    const flowId = `flow-${randomUUID()}`;
    const created = await store.create({
      name: `topN ${randomUUID()}`,
      flowId,
      questions: ["closest", "middle", "farthest"]
    });
    const [closest, middle, farthest] = created.items;

    for (const item of [closest, middle, farthest]) {
      const log = `log-${randomUUID()}`;
      await store.markAnswering(item.id, log);
      await store.completeItem(log, {
        answer: "answer",
        answeredAt: new Date().toISOString(),
        citations: [citation(`sec-${item.id}`)],
        unanswerable: false,
        confidence: "high"
      });
      await store.approveItem(item.id, [citation(`sec-${item.id}`)], false);
    }

    // Two axes blended at a fixed ratio give a deterministic, strictly ordered
    // similarity relative to axis 0 without relying on floating-point ties.
    function blended(primary: number, secondary: number, secondaryWeight: number): number[] {
      const vector = new Array<number>(1536).fill(0);
      vector[primary] = 1;
      vector[secondary] = secondaryWeight;
      return vector;
    }

    await store.setItemEmbeddings([
      { itemId: closest.id, embedding: axisEmbedding(0), model: "topn-model" },
      { itemId: middle.id, embedding: blended(0, 1, 1), model: "topn-model" },
      { itemId: farthest.id, embedding: axisEmbedding(1), model: "topn-model" }
    ]);

    const query = axisEmbedding(0);
    const top2 = await store.matchApprovedTopN(flowId, query, "topn-model", 2);
    assert.equal(top2.length, 2);
    assert.deepEqual(
      top2.map((candidate) => candidate.item.id),
      [closest.id, middle.id]
    );
    assert.ok(top2[0].similarity > top2[1].similarity);
    assert.equal(top2[0].item.citations[0]?.sectionId, `sec-${closest.id}`);

    const all = await store.matchApprovedTopN(flowId, query, "topn-model", 10);
    assert.deepEqual(
      all.map((candidate) => candidate.item.id),
      [closest.id, middle.id, farthest.id]
    );
  });

  it("stashes and reads back reconcile candidate ids", async () => {
    const created = await store.create({ name: `stash ${randomUUID()}`, flowId: "flow-a", questions: ["q0"] });
    const item = created.items[0];

    assert.deepEqual(await store.reconcileCandidateIds(item.id), []);

    await store.setReconcileCandidates(item.id, ["cand-1", "cand-2"]);
    assert.deepEqual(await store.reconcileCandidateIds(item.id), ["cand-1", "cand-2"]);
  });

  it("completeItem records outcome and basis provenance, setting reusedFromItemId only for a single basis", async () => {
    const created = await store.create({
      name: `verdict ${randomUUID()}`,
      flowId: "flow-a",
      questions: ["merged", "adapted"]
    });
    const [mergedItem, adaptedItem] = created.items;

    const mergedLog = `log-${randomUUID()}`;
    await store.markAnswering(mergedItem.id, mergedLog);
    const merged = await store.completeItem(mergedLog, {
      answer: "Merged from two prior answers.",
      answeredAt: new Date().toISOString(),
      citations: [],
      unanswerable: false,
      confidence: "medium",
      outcome: "merged",
      basisItemIds: ["basis-x", "basis-y"]
    });
    assert.equal(merged?.outcome, "merged");
    assert.equal(merged?.reusedFromItemId, undefined, "multi-source basis has no single reused-from item");

    const adaptedLog = `log-${randomUUID()}`;
    await store.markAnswering(adaptedItem.id, adaptedLog);
    const adapted = await store.completeItem(adaptedLog, {
      answer: "Adapted from a single prior answer.",
      answeredAt: new Date().toISOString(),
      citations: [],
      unanswerable: false,
      confidence: "high",
      outcome: "adapted",
      basisItemIds: ["basis-z"]
    });
    assert.equal(adapted?.outcome, "adapted");
    assert.equal(adapted?.reusedFromItemId, "basis-z");
  });

  it("completeItem reconciles the questionnaire_item_basis table on re-answer, clearing stale basis rows", async () => {
    const created = await store.create({ name: `basis-clear ${randomUUID()}`, flowId: "flow-a", questions: ["q0"] });
    const item = created.items[0];

    // First completion: a single-source reuse — a basis_item_id row gets
    // inserted and reused_from_item_id is set from the single basis id.
    const firstLog = `log-${randomUUID()}`;
    await store.markAnswering(item.id, firstLog);
    const first = await store.completeItem(firstLog, {
      answer: "Adapted from a single prior answer.",
      answeredAt: new Date().toISOString(),
      citations: [],
      unanswerable: false,
      confidence: "high",
      outcome: "adapted",
      basisItemIds: ["basis-a"]
    });
    assert.equal(first?.outcome, "adapted");
    assert.equal(first?.reusedFromItemId, "basis-a");
    assert.deepEqual(await store.basisItemIds(item.id), ["basis-a"]);

    // Second completion for the SAME item's question_log_id lineage: a fresh
    // re-answer with no outcome/basisItemIds. The Postgres clearing path
    // (replaceBasis) must DELETE the stale rows, not leave them stranded.
    const secondLog = `log-${randomUUID()}`;
    await store.markAnswering(item.id, secondLog);
    const second = await store.completeItem(secondLog, {
      answer: "A brand new fresh answer, not reused from anything.",
      answeredAt: new Date().toISOString(),
      citations: [],
      unanswerable: false,
      confidence: "medium"
    });

    assert.deepEqual(await store.basisItemIds(item.id), [], "stale basis rows must be cleared");
    assert.equal(second?.reusedFromItemId, undefined, "stale reused-from pointer must be cleared");
  });
});
