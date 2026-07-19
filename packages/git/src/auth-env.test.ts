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

test("buildGitAuthEnv never overrides an ssh remote or credential-embedded url", () => {
  process.env.ACME_PAT = "override";
  assert.deepEqual(buildGitAuthEnv("git@github.com:a/b.git", "ACME_PAT"), {});
  assert.deepEqual(buildGitAuthEnv("https://user:pass@github.com/a/b.git", "ACME_PAT"), {});
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
