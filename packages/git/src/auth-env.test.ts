import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { buildGitAuthEnv, commentOnPullRequest } from "./index.js";

const origGithub = process.env.GITHUB_TOKEN;
const origAzure = process.env.AZURE_DEVOPS_PAT;
const origOverride = process.env.ACME_PAT;
const origFetch = globalThis.fetch;

afterEach(() => {
  restore("GITHUB_TOKEN", origGithub);
  restore("AZURE_DEVOPS_PAT", origAzure);
  restore("ACME_PAT", origOverride);
  globalThis.fetch = origFetch;
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

// Decodes the http.extraheader value buildGitAuthEnv injects, back to the
// "username:secret" the basic-auth header carries, so assertions read the token
// that git would actually present.
function decodeAuthEnv(env: Partial<NodeJS.ProcessEnv>): string | undefined {
  const header = env.GIT_CONFIG_VALUE_0;
  const match = header ? /^Authorization: Basic (.+)$/.exec(header) : null;
  return match ? Buffer.from(match[1], "base64").toString("utf8") : undefined;
}

test("buildGitAuthEnv falls back to GITHUB_TOKEN for github hosts without an override", () => {
  process.env.GITHUB_TOKEN = "ghp_default";
  const env = buildGitAuthEnv("https://github.com/acme/docs.git");
  assert.equal(decodeAuthEnv(env), "x-access-token:ghp_default");
});

test("buildGitAuthEnv prefers the tokenEnv override over GITHUB_TOKEN", () => {
  process.env.GITHUB_TOKEN = "ghp_default";
  process.env.ACME_PAT = "ghp_override";
  const env = buildGitAuthEnv("https://github.com/acme/docs.git", "ACME_PAT");
  assert.equal(decodeAuthEnv(env), "x-access-token:ghp_override");
});

test("buildGitAuthEnv uses the override for Azure DevOps with the pat username", () => {
  process.env.AZURE_DEVOPS_PAT = "azure_default";
  process.env.ACME_PAT = "azure_override";
  const env = buildGitAuthEnv("https://dev.azure.com/org/proj/_git/repo", "ACME_PAT");
  assert.equal(decodeAuthEnv(env), "pat:azure_override");
});

test("buildGitAuthEnv applies an override to an otherwise-unauthenticated host", () => {
  // GitHub Enterprise / self-hosted: no ambient credential applies without an
  // override, but a configured override authenticates with the github-style user.
  delete process.env.GITHUB_TOKEN;
  process.env.ACME_PAT = "enterprise_pat";
  assert.deepEqual(buildGitAuthEnv("https://git.acme.internal/x/y.git"), {});
  const env = buildGitAuthEnv("https://git.acme.internal/x/y.git", "ACME_PAT");
  assert.equal(decodeAuthEnv(env), "x-access-token:enterprise_pat");
});

test("buildGitAuthEnv ignores an override pointing at an unset/blank env var", () => {
  process.env.GITHUB_TOKEN = "ghp_default";
  delete process.env.ACME_PAT;
  // Unset override name → fall back to the host default rather than sending an
  // empty credential.
  assert.equal(decodeAuthEnv(buildGitAuthEnv("https://github.com/a/b.git", "ACME_PAT")), "x-access-token:ghp_default");
  process.env.ACME_PAT = "   ";
  assert.equal(decodeAuthEnv(buildGitAuthEnv("https://github.com/a/b.git", "ACME_PAT")), "x-access-token:ghp_default");
});

test("buildGitAuthEnv never attaches a credential to an ssh remote", () => {
  process.env.ACME_PAT = "override";
  assert.deepEqual(buildGitAuthEnv("git@github.com:a/b.git", "ACME_PAT"), {});
  assert.deepEqual(buildGitAuthEnv("ssh://git@github.com/a/b.git", "ACME_PAT"), {});
});

// TM38: auth is attached over https only.
test("buildGitAuthEnv never attaches a credential over http, git:// or file://", () => {
  process.env.GITHUB_TOKEN = "ghp_default";
  process.env.ACME_PAT = "override";
  assert.deepEqual(buildGitAuthEnv("http://github.com/a/b.git"), {});
  assert.deepEqual(buildGitAuthEnv("http://git.acme.internal/x/y.git", "ACME_PAT"), {});
  assert.deepEqual(buildGitAuthEnv("http://user:pass@git.acme.internal/x/y.git"), {});
  assert.deepEqual(buildGitAuthEnv("git://github.com/a/b.git", "ACME_PAT"), {});
  assert.deepEqual(buildGitAuthEnv("file:///srv/repos/docs.git", "ACME_PAT"), {});
});

// TM36: the embedded https credential authenticates via the header, because the
// URL git is given (and stores) is stripped of it.
test("buildGitAuthEnv sends a credential embedded in an https url as the header", () => {
  process.env.GITHUB_TOKEN = "ghp_default";
  process.env.ACME_PAT = "override";
  assert.equal(
    decodeAuthEnv(buildGitAuthEnv("https://user:p%40ss@github.com/a/b.git", "ACME_PAT")),
    "user:p@ss",
    "the operator's embedded credential wins and is percent-decoded"
  );
  assert.equal(decodeAuthEnv(buildGitAuthEnv("https://ghp_inurl@github.com/a/b.git")), "ghp_inurl:");
});

test("commentOnPullRequest authenticates with the tokenEnv override when set", async () => {
  delete process.env.GITHUB_TOKEN;
  process.env.ACME_PAT = "ghp_override";
  let authHeader = "";
  globalThis.fetch = (async (_url: string, init: { headers: Record<string, string> }) => {
    authHeader = init.headers.Authorization;
    return { ok: true, json: async () => ({ html_url: "https://github.com/o/r/pull/7#c1" }) };
  }) as unknown as typeof fetch;

  const out = await commentOnPullRequest({
    pullRequestUrl: "https://github.com/o/r/pull/7",
    body: "hi",
    tokenEnv: "ACME_PAT"
  });
  assert.equal(out, "https://github.com/o/r/pull/7#c1");
  // No ambient GITHUB_TOKEN — the override alone authenticated the call.
  assert.equal(authHeader, "Bearer ghp_override");
});
