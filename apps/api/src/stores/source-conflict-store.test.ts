import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemorySourceConflictStore,
  conflictFingerprint,
  type SourceConflictUpsert
} from "./source-conflict-store.js";

const POLICY = { sourceId: "policy", path: "security/logging.md", statement: "retained for 1 year" };
const INGEST = { sourceId: "ingest", path: "src/retention.ts", statement: "RETENTION_DAYS = 60" };

function upsertInput(overrides: Partial<SourceConflictUpsert> = {}): SourceConflictUpsert {
  return {
    flowId: "f1",
    documentPath: "kb/logging.md",
    anchor: "logging-retention",
    topic: "log retention period",
    summary: "One source states 1 year, another enforces 60 days.",
    claim: "Logs are retained for 1 year.",
    positions: [POLICY, INGEST],
    ...overrides
  };
}

test("re-detecting the same conflict bumps seenCount instead of inserting", async () => {
  const store = new InMemorySourceConflictStore();
  const first = await store.upsert(upsertInput());
  const second = await store.upsert(upsertInput());
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.conflict.id, first.conflict.id);
  assert.equal(second.conflict.seenCount, 2);
});

test("a dismissed conflict stays dismissed when re-detected", async () => {
  // Otherwise the register refills with judgements the reviewer already made.
  const store = new InMemorySourceConflictStore();
  const { conflict } = await store.upsert(upsertInput());
  await store.dismiss(conflict.id, "the policy is authoritative here");
  const again = await store.upsert(upsertInput());
  assert.equal(again.conflict.status, "dismissed");
  assert.equal(again.conflict.seenCount, 2);
  assert.equal(again.created, false);
});

test("a resolved conflict is not reopened by a re-sighting", async () => {
  const store = new InMemorySourceConflictStore();
  const { conflict } = await store.upsert(upsertInput());
  await store.resolve(conflict.id, "Logs are retained for 60 days.");
  const again = await store.upsert(upsertInput());
  assert.equal(again.conflict.status, "resolved");
});

test("fingerprint is order-independent and topic-normalised, but topic-sensitive", () => {
  const base = { flowId: "f1", documentPath: "kb/logging.md", positions: [POLICY, INGEST] };
  const a = conflictFingerprint({ ...base, topic: "Log Retention" });
  const b = conflictFingerprint({ ...base, topic: "log  retention ", positions: [INGEST, POLICY] });
  const c = conflictFingerprint({ ...base, topic: "encryption at rest" });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("the unscoped flow still dedupes", async () => {
  // flowId folds in as a sentinel rather than a NULL: Postgres treats NULLs as
  // distinct in a unique index, which would silently defeat dedupe here.
  const store = new InMemorySourceConflictStore();
  await store.upsert(upsertInput({ flowId: undefined }));
  const second = await store.upsert(upsertInput({ flowId: undefined }));
  assert.equal(second.created, false);
  assert.equal(second.conflict.seenCount, 2);
});

test("conflicts in different documents are separate rows", async () => {
  const store = new InMemorySourceConflictStore();
  await store.upsert(upsertInput());
  const other = await store.upsert(upsertInput({ documentPath: "kb/other.md" }));
  assert.equal(other.created, true);
});

test("listOpenPaths returns each conflicted document once", async () => {
  const store = new InMemorySourceConflictStore();
  await store.upsert(upsertInput());
  await store.upsert(upsertInput({ topic: "encryption at rest" }));
  await store.upsert(upsertInput({ documentPath: "kb/other.md" }));
  const paths = await store.listOpenPaths("f1");
  assert.deepEqual([...paths].sort(), ["kb/logging.md", "kb/other.md"]);
});

test("listOpenPaths excludes dismissed and resolved conflicts", async () => {
  const store = new InMemorySourceConflictStore();
  const { conflict } = await store.upsert(upsertInput());
  await store.dismiss(conflict.id, "not a conflict");
  assert.deepEqual(await store.listOpenPaths("f1"), []);
});

test("list filters by status", async () => {
  const store = new InMemorySourceConflictStore();
  const { conflict } = await store.upsert(upsertInput());
  await store.upsert(upsertInput({ documentPath: "kb/other.md" }));
  await store.dismiss(conflict.id, "no");
  const open = await store.list({ status: "open", limit: 10 });
  assert.equal(open.length, 1);
  assert.equal(open[0]?.documentPath, "kb/other.md");
});

test("recordAnnotation links the annotation proposal", async () => {
  const store = new InMemorySourceConflictStore();
  const { conflict } = await store.upsert(upsertInput());
  const updated = await store.recordAnnotation(conflict.id, "p1");
  assert.equal(updated?.annotatedProposalId, "p1");
});
