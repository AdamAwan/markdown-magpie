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

  // answer_question requires provider + question; an empty input must not persist.
  const res = await post(app, { type: "answer_question", input: {} });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: string }).error, "invalid_job_input");
});

test("POST /api/jobs accepts a valid input and enqueues it (202)", async () => {
  const ctx = makeTestContext();
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
