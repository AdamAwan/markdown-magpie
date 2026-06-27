import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChangesetChange, DocumentSection, KnowledgeDocument, MaintenancePlan, RankedSection } from "@magpie/core";
import { makeTestContext } from "../../test-support/context.js";
import {
  buildRetrievalQuery,
  changesetFromPlan,
  constrainToCandidates,
  selectCandidateDocuments,
  triggerSourceSyncRun
} from "./service.js";

test("changesetFromPlan applies deletes then writes with last-write-wins per path", () => {
  const plan: MaintenancePlan = {
    summary: "tidy",
    operations: [
      {
        kind: "split",
        title: "delete a.md",
        reason: "r",
        sources: ["a.md"],
        writes: [],
        deletes: ["a.md"]
      },
      {
        kind: "rewrite",
        title: "rewrite a.md",
        reason: "r",
        sources: ["a.md"],
        writes: [{ path: "a.md", content: "# A\nrewritten" }],
        deletes: []
      }
    ],
    rationale: "r"
  };

  const changes = changesetFromPlan(plan);

  const forA = changes.filter((change) => change.path === "a.md");
  assert.equal(forA.length, 1, "a path deleted then written collapses to a single entry");
  assert.equal(forA[0].content, "# A\nrewritten");
  assert.equal(forA[0].delete, undefined, "the surviving entry is a write, not a delete");
});

function section(id: string, documentId: string): DocumentSection {
  return { id, documentId, path: "", heading: "", headingPath: [], anchor: "", content: "", ordinal: 0 };
}

function document(id: string, path: string): KnowledgeDocument {
  return {
    id,
    repositoryId: "dest",
    path,
    metadata: { title: path, status: "active", tags: [], relatedDocs: [] },
    content: `# ${path}`
  };
}

function ranked(sections: DocumentSection[]): RankedSection[] {
  return sections.map((s, index) => ({ section: s, relevance: 1 - index * 0.1 }));
}

test("selectCandidateDocuments collapses sections to distinct docs in rank order and caps", async () => {
  const docs = [document("d1", "a.md"), document("d2", "b.md"), document("d3", "c.md")];
  // d2 ranks first, then d1 (twice — deduped), then d3.
  const sectionsRanked = ranked([section("s2", "d2"), section("s1", "d1"), section("s1b", "d1"), section("s3", "d3")]);

  const candidates = selectCandidateDocuments(sectionsRanked, docs, 2);

  assert.deepEqual(
    candidates.map((candidate) => candidate.path),
    ["b.md", "a.md"],
    "distinct docs in rank order, limited to 2"
  );
});

test("selectCandidateDocuments ignores sections whose document is missing", async () => {
  const candidates = selectCandidateDocuments(ranked([section("s", "ghost")]), [document("d1", "a.md")], 5);
  assert.deepEqual(candidates, []);
});

test("constrainToCandidates drops deletes and paths outside the candidate set", async () => {
  const candidates = [{ path: "a.md", content: "x" }];
  const changes: ChangesetChange[] = [
    { path: "a.md", content: "updated" },
    { path: "b.md", content: "invented" },
    { path: "a.md", delete: true }
  ];

  const constrained = constrainToCandidates(changes, candidates);

  assert.equal(constrained.length, 1);
  assert.equal(constrained[0].path, "a.md");
  assert.equal(constrained[0].content, "updated");
});

test("buildRetrievalQuery includes paths and diffs and is bounded", async () => {
  const query = buildRetrievalQuery([{ path: "src/rules.ts", status: "modified", diff: "- 2024\n+ 2025" }]);
  assert.match(query, /src\/rules\.ts/);
  assert.match(query, /2025/);

  const huge = buildRetrievalQuery([{ path: "f", status: "modified", diff: "x".repeat(20_000) }]);
  assert.ok(huge.length <= 6_000, "query is truncated to the cap");
});

test("triggerSourceSyncRun is a no-op when the flow has no git sources", async () => {
  const ctx = makeTestContext();
  const runs = await triggerSourceSyncRun(ctx, { trigger: "manual" });
  assert.deepEqual(runs, { maintenanceRunIds: [], proposalIds: [] });
});
