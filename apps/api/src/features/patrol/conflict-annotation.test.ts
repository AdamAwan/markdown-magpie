import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestContext } from "../../test-support/context.js";
import type { VerifyDocumentFn } from "../../scheduling/verify-lens.js";
import type { DedupeDocumentFn } from "../../scheduling/dedupe-lens.js";
import type { SplitDocumentFn } from "../../scheduling/split-lens.js";
import * as patrol from "./service.js";
import type { CorrectDocumentFn } from "./service.js";

async function indexDocs(ctx: ReturnType<typeof makeTestContext>, paths: string[]): Promise<void> {
  await ctx.stores.knowledgeIndex.indexMarkdownDocuments({
    repositoryId: "docs",
    documents: paths.map((path) => ({ path, content: `# ${path}` }))
  });
}

const CONFLICT = {
  topic: "log retention period",
  summary: "One source states 1 year, another enforces 60 days.",
  // indexDocs writes "# a.md" as the only heading, so this is its section anchor.
  anchor: "a-md",
  claim: "Logs are retained for 1 year.",
  positions: [
    { sourceId: "policy", path: "security/logging.md", statement: "retained for 1 year" },
    { sourceId: "ingest", path: "src/retention.ts", statement: "RETENTION_DAYS = 60" }
  ]
};

const QUIET: { dedupeDocument: DedupeDocumentFn; splitDocument: SplitDocumentFn } = {
  dedupeDocument: async () => {},
  splitDocument: async () => {}
};

// Merges the annotation proposal and re-indexes the document with the annotated
// body — what actually happens when a human merges the PR.
//
// Until that merge the document is excluded from every later tick by
// flowCoveredPaths (an open same-flow proposal already covers it), so a test that
// skipped this step would be exercising the covered-path filter, not the conflict
// lifecycle.
async function mergeAnnotation(ctx: ReturnType<typeof makeTestContext>): Promise<void> {
  const proposals = await ctx.stores.proposals.list(10);
  for (const proposal of proposals) {
    if (proposal.status === "draft") {
      await ctx.stores.proposals.updateStatus(proposal.id, "merged");
      await ctx.stores.knowledgeIndex.indexMarkdownDocuments({
        repositoryId: "docs",
        documents: [{ path: proposal.targetPath ?? "", content: proposal.markdown }]
      });
    }
  }
}

function conflictVerifier(): VerifyDocumentFn {
  return async () => ({ verdict: "healthy", claims: [], conflicts: [CONFLICT] });
}

test("a detected conflict is recorded and annotates the document without correcting it", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md"]);
  const corrections: string[] = [];

  const outcome = await patrol.runFixPatrol(
    ctx,
    { trigger: "manual" },
    {
      ...QUIET,
      verifyDocument: conflictVerifier(),
      correctDocument: (async (_ctx, input) => {
        corrections.push(input.path);
      }) as CorrectDocumentFn
    }
  );

  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.equal(outcome.conflictCount, 1);
  // The regression this feature exists for: a source disagreement must never be
  // "corrected", which would rewrite the document to one side of it.
  assert.deepEqual(corrections, []);

  const registered = await ctx.stores.sourceConflicts.list({ limit: 10 });
  assert.equal(registered.length, 1);
  assert.equal(registered[0]?.status, "open");
  assert.equal(registered[0]?.topic, "log retention period");

  const proposals = await ctx.stores.proposals.list(10);
  assert.equal(proposals.length, 1);
  assert.match(proposals[0].title, /^Conflict: log retention period/);
  assert.match(proposals[0].markdown, /<!-- magpie:conflict id=/);
  assert.match(proposals[0].markdown, /Unresolved source conflict/);
  // Source paths belong in the PR body, never in the published document (#214).
  assert.ok(!proposals[0].markdown.includes("src/retention.ts"));
  assert.match(proposals[0].rationale ?? "", /src\/retention\.ts/);
  assert.equal(registered[0]?.annotatedProposalId, proposals[0].id);
});

test("a re-detected conflict bumps the sighting but does not annotate again", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md"]);
  const deps = {
    ...QUIET,
    verifyDocument: conflictVerifier(),
    correctDocument: (async () => {}) as CorrectDocumentFn
  };

  await patrol.runFixPatrol(ctx, { trigger: "manual" }, deps);
  await mergeAnnotation(ctx);
  await patrol.runFixPatrol(ctx, { trigger: "manual" }, deps);

  const registered = await ctx.stores.sourceConflicts.list({ limit: 10 });
  assert.equal(registered.length, 1, "one conflict, not one per tick");
  assert.equal(registered[0]?.seenCount, 2);
  // list() excludes merged proposals, so an empty active list means the second
  // tick opened no new annotation.
  assert.deepEqual(await ctx.stores.proposals.list(10), [], "no second annotation proposal");
  assert.equal((await ctx.stores.proposals.list(10, { status: "merged" })).length, 1, "annotated exactly once");
});

test("a document with an open conflict is re-verified despite unchanged hashes", async () => {
  // Without the change-gate exemption an annotated document is skipped forever:
  // its body and its source descriptors are both stable, and a source-content
  // change deliberately does not bust the gate. The conflict could then never be
  // observed as resolved, however many times someone fixed the sources.
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md", "b.md"]);
  const verified: string[] = [];

  await patrol.runFixPatrol(
    ctx,
    { trigger: "manual" },
    {
      ...QUIET,
      verifyDocument: async (_ctx, { path }) => {
        verified.push(path);
        return path === "a.md"
          ? { verdict: "healthy", claims: [], conflicts: [CONFLICT] }
          : { verdict: "healthy", claims: [] };
      },
      correctDocument: (async () => {}) as CorrectDocumentFn
    }
  );
  assert.deepEqual(verified.sort(), ["a.md", "b.md"]);
  await mergeAnnotation(ctx);

  // Tick 2: a.md's body changed (the marker landed), so it re-verifies on the
  // ordinary gate rule and both docs settle with a recorded hash.
  const quietVerify: VerifyDocumentFn = async (_ctx, { path }) => {
    verified.push(path);
    return { verdict: "healthy", claims: [] };
  };
  verified.length = 0;
  await patrol.runFixPatrol(
    ctx,
    { trigger: "manual" },
    { ...QUIET, verifyDocument: quietVerify, correctDocument: (async () => {}) as CorrectDocumentFn }
  );
  assert.ok(verified.includes("a.md"));

  // Tick 3 is the real test: nothing has changed since tick 2, so b.md is gated.
  // a.md still holds an open conflict, so it must be re-checked anyway — that is
  // the only way a source-side fix is ever noticed.
  verified.length = 0;
  await patrol.runFixPatrol(
    ctx,
    { trigger: "manual" },
    { ...QUIET, verifyDocument: quietVerify, correctDocument: (async () => {}) as CorrectDocumentFn }
  );
  assert.deepEqual(verified, ["a.md"], "only the conflicted doc escapes the change gate");
});

test("the verify input carries the document's open conflicts", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md"]);
  const seen: Array<Array<{ id: string }> | undefined> = [];
  const deps = {
    ...QUIET,
    verifyDocument: (async (_ctx, input) => {
      seen.push(input.knownConflicts);
      return { verdict: "healthy" as const, claims: [], conflicts: [CONFLICT] };
    }) as VerifyDocumentFn,
    correctDocument: (async () => {}) as CorrectDocumentFn
  };

  await patrol.runFixPatrol(ctx, { trigger: "manual" }, deps);
  assert.equal(seen[0], undefined, "first tick has nothing to re-check, so the prompt is unchanged");

  await mergeAnnotation(ctx);
  await patrol.runFixPatrol(ctx, { trigger: "manual" }, deps);
  const registered = await ctx.stores.sourceConflicts.list({ limit: 10 });
  assert.deepEqual(
    seen[1]?.map((conflict) => conflict.id),
    [registered[0]?.id],
    "the second tick tells the agent about the open conflict"
  );
});

test("a resolved conflict closes the register entry and repairs the document", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md"]);
  const corrections: Array<{ path: string; content: string; reason: string }> = [];
  const correctDocument = (async (_ctx, input) => {
    corrections.push({ path: input.path, content: input.content, reason: input.claims[0]?.reason ?? "" });
  }) as CorrectDocumentFn;

  await patrol.runFixPatrol(ctx, { trigger: "manual" }, { ...QUIET, verifyDocument: conflictVerifier(), correctDocument });
  const conflictId = (await ctx.stores.sourceConflicts.list({ limit: 10 }))[0]?.id ?? "";
  await mergeAnnotation(ctx);

  const outcome = await patrol.runFixPatrol(
    ctx,
    { trigger: "manual" },
    {
      ...QUIET,
      verifyDocument: async () => ({
        verdict: "healthy",
        claims: [],
        resolvedConflicts: [{ id: conflictId, agreedStatement: "Logs are retained for 60 days." }]
      }),
      correctDocument
    }
  );

  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.equal(outcome.resolvedConflictCount, 1);
  const stored = await ctx.stores.sourceConflicts.get(conflictId);
  assert.equal(stored?.status, "resolved");
  assert.equal(stored?.agreedStatement, "Logs are retained for 60 days.");

  assert.equal(corrections.length, 1);
  assert.match(corrections[0].reason, /they now agree: Logs are retained for 60 days\./);
  assert.ok(!corrections[0].content.includes("magpie:conflict"), "the marker is stripped before the repair");
});

test("a resolution for an unknown conflict is ignored", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md"]);
  const corrections: string[] = [];

  const outcome = await patrol.runFixPatrol(
    ctx,
    { trigger: "manual" },
    {
      ...QUIET,
      verifyDocument: async () => ({
        verdict: "healthy",
        claims: [],
        resolvedConflicts: [{ id: "not-a-real-conflict", agreedStatement: "whatever" }]
      }),
      correctDocument: (async (_ctx, input) => {
        corrections.push(input.path);
      }) as CorrectDocumentFn
    }
  );

  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.equal(outcome.resolvedConflictCount, 0);
  assert.deepEqual(corrections, []);
});

test("a dismissed conflict is never re-annotated when re-detected", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md"]);
  const deps = {
    ...QUIET,
    verifyDocument: conflictVerifier(),
    correctDocument: (async () => {}) as CorrectDocumentFn
  };

  await patrol.runFixPatrol(ctx, { trigger: "manual" }, deps);
  const conflictId = (await ctx.stores.sourceConflicts.list({ limit: 10 }))[0]?.id ?? "";
  await ctx.stores.sourceConflicts.dismiss(conflictId, "the policy is authoritative here");
  await mergeAnnotation(ctx);

  await patrol.runFixPatrol(ctx, { trigger: "manual" }, deps);

  const stored = await ctx.stores.sourceConflicts.get(conflictId);
  assert.equal(stored?.status, "dismissed", "a judgement already made is not undone by a re-sighting");
  assert.deepEqual(await ctx.stores.proposals.list(10), [], "no second annotation proposal");
});
