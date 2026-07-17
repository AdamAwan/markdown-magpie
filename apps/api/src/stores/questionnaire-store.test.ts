import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryQuestionnaireStore, type StoredItem } from "./questionnaire-store.js";

describe("InMemoryQuestionnaireStore", () => {
  describe("matchApprovedTopN", () => {
    it("returns approved candidates ordered by descending similarity and respects limit", async () => {
      const store = new InMemoryQuestionnaireStore();
      const flowId = "flow-topn";
      const created = await store.create({
        name: "topN questionnaire",
        flowId,
        questions: ["closest", "middle", "farthest"]
      });
      const [closest, middle, farthest] = created.items;

      // Approve all three so they're eligible as reuse candidates.
      await store.approveItem(closest.id, [], false);
      await store.approveItem(middle.id, [], false);
      await store.approveItem(farthest.id, [], false);

      await store.setItemEmbeddings([
        { itemId: closest.id, embedding: [1, 0], model: "test-model" },
        { itemId: middle.id, embedding: [1, 1], model: "test-model" },
        { itemId: farthest.id, embedding: [0, 1], model: "test-model" }
      ]);

      const query = [1, 0];
      const top2 = await store.matchApprovedTopN(flowId, query, "test-model", 2);

      assert.equal(top2.length, 2, "respects the limit");
      assert.deepEqual(
        top2.map((candidate) => candidate.item.id),
        [closest.id, middle.id],
        "orders by descending similarity"
      );
      assert.ok(
        top2[0].similarity > top2[1].similarity,
        "the first candidate must be strictly more similar than the second"
      );

      const all = await store.matchApprovedTopN(flowId, query, "test-model", 10);
      assert.deepEqual(
        all.map((candidate) => candidate.item.id),
        [closest.id, middle.id, farthest.id],
        "a limit above the candidate count still returns full descending order"
      );
    });
  });

  describe("completeItem verdict-aware completion", () => {
    it("records the outcome and, for multiple basis items, no single reusedFromItemId", async () => {
      const store = new InMemoryQuestionnaireStore();
      const created = await store.create({
        name: "merged questionnaire",
        flowId: "flow-merge",
        questions: ["q0"]
      });
      const item = created.items[0];
      const logId = "log-merge";
      await store.markAnswering(item.id, logId);

      const completed = await store.completeItem(logId, {
        answer: "Merged answer drawing on two prior answers.",
        answeredAt: new Date().toISOString(),
        citations: [],
        unanswerable: false,
        confidence: "medium",
        outcome: "merged",
        basisItemIds: ["basis-x", "basis-y"]
      });

      assert.equal(completed?.status, "answered");
      assert.equal(completed?.outcome, "merged");
      assert.equal(completed?.reusedFromItemId, undefined, "multi-source basis has no single reused-from item");
    });

    it("sets reusedFromItemId when completion has exactly one basis item", async () => {
      const store = new InMemoryQuestionnaireStore();
      const created = await store.create({
        name: "adapted questionnaire",
        flowId: "flow-adapt",
        questions: ["q0"]
      });
      const item = created.items[0];
      const logId = "log-adapt";
      await store.markAnswering(item.id, logId);

      const completed = await store.completeItem(logId, {
        answer: "Adapted from a single prior answer.",
        answeredAt: new Date().toISOString(),
        citations: [],
        unanswerable: false,
        confidence: "high",
        outcome: "adapted",
        basisItemIds: ["basis-z"]
      });

      assert.equal(completed?.outcome, "adapted");
      assert.equal(completed?.reusedFromItemId, "basis-z");
    });

    it("clears stale reusedFromItemId and basisItemIds on a fresh re-answer with no basis", async () => {
      const store = new InMemoryQuestionnaireStore();
      const created = await store.create({
        name: "re-answered questionnaire",
        flowId: "flow-reanswer",
        questions: ["q0"]
      });
      const item = created.items[0];

      // First completion: a single-source reuse, so reusedFromItemId and
      // basisItemIds both get set.
      const firstLog = "log-reanswer-1";
      await store.markAnswering(item.id, firstLog);
      const first = (await store.completeItem(firstLog, {
        answer: "Adapted from a single prior answer.",
        answeredAt: new Date().toISOString(),
        citations: [],
        unanswerable: false,
        confidence: "high",
        outcome: "adapted",
        basisItemIds: ["basis-z"]
      })) as StoredItem;
      assert.equal(first.reusedFromItemId, "basis-z");
      assert.deepEqual(first.basisItemIds, ["basis-z"]);

      // Second completion for the SAME item: a fresh re-answer with no
      // outcome/basisItemIds. Provenance must be fully reconciled to this
      // completion — not left stale from the earlier reuse.
      const secondLog = "log-reanswer-2";
      await store.markAnswering(item.id, secondLog);
      const second = (await store.completeItem(secondLog, {
        answer: "A brand new fresh answer, not reused from anything.",
        answeredAt: new Date().toISOString(),
        citations: [],
        unanswerable: false,
        confidence: "medium"
      })) as StoredItem;

      assert.equal(second.reusedFromItemId, undefined, "stale reused-from pointer must be cleared");
      assert.deepEqual(second.basisItemIds, [], "stale basis must be cleared");
    });
  });

  describe("reconcile candidate stash", () => {
    it("round-trips the candidate ids offered to the reconciler", async () => {
      const store = new InMemoryQuestionnaireStore();
      const created = await store.create({
        name: "candidate stash questionnaire",
        flowId: "flow-stash",
        questions: ["q0"]
      });
      const item = created.items[0];

      assert.deepEqual(await store.reconcileCandidateIds(item.id), []);

      await store.setReconcileCandidates(item.id, ["cand-1", "cand-2"]);
      assert.deepEqual(await store.reconcileCandidateIds(item.id), ["cand-1", "cand-2"]);
    });
  });
});
