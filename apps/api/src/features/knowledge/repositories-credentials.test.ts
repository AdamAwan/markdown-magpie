import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildApp } from "../../app.js";
import { withoutRemoteCredentials } from "../../platform/repositories.js";
import { makeTestContext } from "../../test-support/context.js";

const exec = promisify(execFile);

const CREDENTIALED = "https://x-access-token:ghp_secret@github.com/acme/docs.git";

// A local repository whose stored origin embeds a token — what a checkout cloned
// by an older version (or a hand-configured local repository) looks like.
async function repoWithCredentialedOrigin(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "magpie-cred-repo-"));
  await exec("git", ["init", "--initial-branch=main"], { cwd: repo });
  await exec("git", ["remote", "add", "origin", CREDENTIALED], { cwd: repo });
  await writeFile(path.join(repo, "guide.md"), "# Guide\n\nBody.\n", "utf8");
  return repo;
}

test("GET /api/knowledge/repositories never returns a credential in a remote URL (TM37)", async () => {
  const ctx = makeTestContext();
  await ctx.stores.knowledgeIndex.indexLocalRepository({ localPath: await repoWithCredentialedOrigin() });
  const app = buildApp(ctx);

  const res = await app.request("/api/knowledge/repositories");
  const text = await res.text();

  assert.equal(res.status, 200);
  assert.doesNotMatch(text, /ghp_secret|x-access-token/);
  const body = JSON.parse(text) as { repositories: Array<{ remoteUrl?: string; git?: { remoteUrl?: string } }> };
  assert.equal(body.repositories[0]?.remoteUrl, "https://github.com/acme/docs.git");
  assert.equal(body.repositories[0]?.git?.remoteUrl, "https://github.com/acme/docs.git");
});

test("withoutRemoteCredentials strips both remote URLs and leaves the rest untouched", () => {
  const stripped = withoutRemoteCredentials({
    id: "kb",
    name: "kb",
    defaultBranch: "main",
    localPath: "/data/kb",
    provider: "local",
    remoteUrl: CREDENTIALED,
    git: { scope: "repository-root", indexedPath: "/data/kb", remoteUrl: CREDENTIALED, headSha: "abc" }
  });
  assert.equal(stripped.remoteUrl, "https://github.com/acme/docs.git");
  assert.deepEqual(stripped.git, {
    scope: "repository-root",
    indexedPath: "/data/kb",
    remoteUrl: "https://github.com/acme/docs.git",
    headSha: "abc"
  });
  const bare = withoutRemoteCredentials({
    id: "x",
    name: "x",
    defaultBranch: "main",
    localPath: "/x",
    provider: "local"
  });
  assert.equal("remoteUrl" in bare, false);
  assert.equal("git" in bare, false);
});
