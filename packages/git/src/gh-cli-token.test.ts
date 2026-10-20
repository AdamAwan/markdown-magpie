import assert from "node:assert/strict";
import { test } from "node:test";
import { hydrateGithubTokenFromGhCli } from "./gh-cli-token.js";

const neverCalled = async (): Promise<string> => {
  throw new Error("gh should not be invoked");
};

test("keeps an explicit GITHUB_TOKEN and never runs gh", async () => {
  const env: NodeJS.ProcessEnv = { GITHUB_TOKEN: "ghp_explicit" };
  assert.equal(await hydrateGithubTokenFromGhCli(env, neverCalled), "env");
  assert.equal(env.GITHUB_TOKEN, "ghp_explicit");
});

test("fills GITHUB_TOKEN from the gh CLI when unset", async () => {
  const env: NodeJS.ProcessEnv = {};
  assert.equal(await hydrateGithubTokenFromGhCli(env, async () => "gho_fromcli\n"), "gh-cli");
  assert.equal(env.GITHUB_TOKEN, "gho_fromcli");
});

test("treats a blank GITHUB_TOKEN as unset", async () => {
  const env: NodeJS.ProcessEnv = { GITHUB_TOKEN: "  " };
  assert.equal(await hydrateGithubTokenFromGhCli(env, async () => "gho_fromcli"), "gh-cli");
  assert.equal(env.GITHUB_TOKEN, "gho_fromcli");
});

test("MAGPIE_GH_CLI_AUTH=false opts out", async () => {
  const env: NodeJS.ProcessEnv = { MAGPIE_GH_CLI_AUTH: "false" };
  assert.equal(await hydrateGithubTokenFromGhCli(env, neverCalled), "none");
  assert.equal(env.GITHUB_TOKEN, undefined);
});

test("a missing gh or no login leaves GITHUB_TOKEN unset", async () => {
  const env: NodeJS.ProcessEnv = {};
  const failing = async (): Promise<string> => {
    throw new Error("spawn gh ENOENT");
  };
  assert.equal(await hydrateGithubTokenFromGhCli(env, failing), "none");
  assert.equal(await hydrateGithubTokenFromGhCli(env, async () => ""), "none");
  assert.equal(env.GITHUB_TOKEN, undefined);
});
