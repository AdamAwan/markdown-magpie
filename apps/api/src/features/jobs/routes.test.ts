import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../app.js";
import { makeTestContext } from "../../test-support/context.js";

// Auth is disabled in the test context, so requireScopes is a pass-through and we
// exercise the POST /api/jobs boundary directly. These pin #285: the endpoint
// validates `input` against the job's own contract at creation, so a dangerous git
// source url (RCE / argument injection) or a malformed payload is rejected with a
// 400 and never persisted or dispatched.

async function post(app: ReturnType<typeof buildApp>, body: unknown): Promise<Response> {
  return app.request("/api/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

const validVerifyInput = (url: string) => ({
  provider: "codex",
  path: "kb/refunds.md",
  content: "Refunds take 5 days.",
  sources: [{ id: "src-1", name: "Repo", kind: "git", url }]
});

test("POST /api/jobs rejects a source descriptor with an ext:: RCE url (400)", async () => {
  const ctx = makeTestContext();
  const app = buildApp(ctx);

  const res = await post(app, {
    type: "verify_document",
    input: validVerifyInput("ext::sh -c 'touch /tmp/magpie-pwned'")
  });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: string }).error, "invalid_job_input");

  // Nothing was enqueued.
  const { jobs } = await ctx.jobs.list({ type: "verify_document" });
  assert.equal(jobs.length, 0);
});

test("POST /api/jobs rejects file:// SSRF-style and --upload-pack= argument injection urls", async () => {
  const ctx = makeTestContext();
  const app = buildApp(ctx);

  for (const url of ["--upload-pack=touch /tmp/magpie-pwned", "git://internal.example.com/repo.git"]) {
    const res = await post(app, { type: "verify_document", input: validVerifyInput(url) });
    assert.equal(res.status, 400, `expected 400 for ${url}`);
  }
  const { jobs } = await ctx.jobs.list({ type: "verify_document" });
  assert.equal(jobs.length, 0);
});

test("POST /api/jobs rejects an input missing a required contract field (400)", async () => {
  const ctx = makeTestContext();
  const app = buildApp(ctx);

  // summarize_gap requires provider + questions; an empty input must not persist.
  const res = await post(app, { type: "summarize_gap", input: {} });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: string }).error, "invalid_job_input");
});

// docs/ai-jobs.md J67: internal-only job types cannot be created by hand — e.g.
// a comment/crosslink job whose caller-chosen pullRequestUrl + tokenEnv would aim
// a github watcher's credential at an arbitrary PR.
test("POST /api/jobs rejects internal-only job types (400 job_type_not_submittable)", async () => {
  const internal: Array<[string, unknown]> = [
    [
      "comment_pull_request",
      { pullRequestUrl: "https://github.com/victim/repo/pull/1", body: "hi", tokenEnv: "OTHER_TOKEN" }
    ],
    [
      "crosslink_pull_requests",
      {
        pullRequestUrl: "https://github.com/victim/repo/pull/1",
        relatedPullRequestUrl: "https://github.com/victim/repo/pull/2",
        tokenEnv: "OTHER_TOKEN"
      }
    ],
    ["answer_question", { provider: "codex", question: "q", flows: [], expectedOutput: "answer_result" }],
    ["publish_proposal", { proposalId: "p1" }]
  ];
  for (const [type, input] of internal) {
    const ctx = makeTestContext();
    const res = await post(buildApp(ctx), { type, input });
    assert.equal(res.status, 400, type);
    assert.equal(((await res.json()) as { error: string }).error, "job_type_not_submittable", type);
    assert.equal((await ctx.jobs.list({})).total, 0, `${type}: nothing enqueued`);
  }
});

test("POST /api/jobs admits a hand-submitted AI job through the AI capacity gate (429 when full)", async () => {
  const ctx = makeTestContext();
  ctx.settings.rateLimit.enabled = true;
  ctx.settings.rateLimit.aiMaxInflightJobs = 1;
  ctx.settings.rateLimit.aiInteractiveReservedJobs = 0;
  const submit = () =>
    post(buildApp(ctx), {
      type: "summarize_gap",
      input: { provider: "codex", questions: ["Q?"], citedSections: [], expectedOutput: "gap_summary" }
    });
  assert.equal((await submit()).status, 202);
  await ctx.jobs.claim("codex-watcher", ["codex"]); // now one ACTIVE job holds the only slot
  const res = await submit();
  assert.equal(res.status, 429);
  assert.equal(((await res.json()) as { error: string }).error, "ai_capacity");
});

// The operator-configured source the accepted submissions below reference.
const configuredRepo = { id: "src-1", name: "Repo", kind: "git" as const, url: "https://example.com/repo.git" };

test("POST /api/jobs accepts a valid input and enqueues it (202)", async () => {
  const ctx = makeTestContext({ knowledgeConfig: { ...makeTestContext().knowledgeConfig, sources: [configuredRepo] } });
  const app = buildApp(ctx);

  const res = await post(app, {
    type: "verify_document",
    input: validVerifyInput("https://example.com/repo.git")
  });
  assert.equal(res.status, 202);
  const body = (await res.json()) as { job: { id: string; type: string } };
  assert.equal(body.job.type, "verify_document");

  const { jobs } = await ctx.jobs.list({ type: "verify_document" });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.id, body.job.id);
});

// docs/ai-jobs.md J52: an externally submitted job's source descriptors must be
// exactly what the API projects from operator config — a caller cannot choose a
// host path, a subpath, a different url, or a fetch allowlist.
function contextWithSources(): ReturnType<typeof makeTestContext> {
  const base = makeTestContext();
  return makeTestContext({
    knowledgeConfig: {
      ...base.knowledgeConfig,
      sources: [
        configuredRepo,
        { id: "notes", name: "Notes", kind: "local", path: "knowledge-bases/notes", subpath: "docs" },
        {
          id: "web",
          name: "Vendor docs",
          kind: "internet",
          url: "https://docs.example.com",
          allowedHosts: ["docs.example.com"]
        },
        { id: "agent", name: "Agent Knowledge", kind: "agent" }
      ]
    }
  });
}

const configuredNotes = { id: "notes", name: "Notes", kind: "local", path: "knowledge-bases/notes", subpath: "docs" };
const configuredWeb = {
  id: "web",
  name: "Vendor docs",
  kind: "internet",
  url: "https://docs.example.com",
  allowedHosts: ["docs.example.com"]
};

function verifyWith(sources: unknown[]) {
  return { type: "verify_document", input: { provider: "codex", path: "kb/a.md", content: "x", sources } };
}

test("POST /api/jobs rejects caller-authored source descriptors that differ from operator config", async () => {
  const forged: Array<[string, unknown]> = [
    ["local path pointed at the host root", { ...configuredNotes, path: "/" }],
    ["subpath climbing out of the checkout", { ...configuredRepo, subpath: "../../.." }],
    ["subpath dropped (widens the root)", { id: "notes", name: "Notes", kind: "local", path: "knowledge-bases/notes" }],
    ["a different url for a configured id", { ...configuredRepo, url: "https://attacker.example/repo.git" }],
    ["an injected fetch allowlist (SSRF)", { ...configuredWeb, allowedHosts: ["169.254.169.254"] }],
    [
      "a configured id re-kinded as fetchable",
      { id: "agent", name: "Agent Knowledge", kind: "internet", allowedHosts: ["x.test"] }
    ],
    ["an unknown source id", { id: "ghost", name: "Ghost", kind: "local", path: "/etc" }]
  ];
  for (const [label, descriptor] of forged) {
    const ctx = contextWithSources();
    const res = await post(buildApp(ctx), verifyWith([configuredRepo, descriptor]));
    assert.equal(res.status, 400, label);
    assert.equal(((await res.json()) as { error: string }).error, "unconfigured_job_source", label);
    const { jobs } = await ctx.jobs.list({ type: "verify_document" });
    assert.equal(jobs.length, 0, `${label}: nothing enqueued`);
  }
});

test("POST /api/jobs accepts descriptors that exactly match operator config", async () => {
  const ctx = contextWithSources();
  const agent = { id: "agent", name: "Agent Knowledge", kind: "agent" };
  const res = await post(buildApp(ctx), verifyWith([configuredRepo, configuredNotes, configuredWeb, agent]));
  assert.equal(res.status, 202);
});

test("POST /api/jobs leaves jobs without sources unaffected", async () => {
  const res = await post(buildApp(makeTestContext()), {
    type: "summarize_gap",
    input: { provider: "codex", questions: ["Q?"], citedSections: [], expectedOutput: "gap_summary" }
  });
  assert.equal(res.status, 202);
});
