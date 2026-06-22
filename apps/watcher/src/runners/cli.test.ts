import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JobView } from "@magpie/jobs";
import { CliRunner } from "./cli.js";

function job(type: JobView["type"], input: unknown): JobView {
  return {
    id: "j",
    type,
    queueName: type,
    deadLetter: false,
    state: "active",
    input,
    retryCount: 0,
    retryLimit: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expireInSeconds: 300
  };
}

const SUMMARIZE = job("summarize_gap", { questions: ["q"], citedSections: [] });
const RESULT_JSON = JSON.stringify({ summary: "s", priority: 1, rationale: "r" });

describe("CliRunner", () => {
  it("exposes its provider capability and supports AI job types", () => {
    const runner = new CliRunner({ capability: "codex", command: "true", args: [], promptMode: "arg" });
    assert.equal(runner.capability, "codex");
    assert.ok(runner.supports("summarize_gap"));
    assert.ok(runner.supports("sync_source_changes_generate_plan"));
    assert.ok(!runner.supports("publish_proposal"));
  });

  it("passes the prompt as the final arg in arg mode and parses JSON stdout", async () => {
    // `printf %s "$LAST_ARG"` echoes the final argument — i.e. the prompt — which
    // happens to be the JSON the runner then parses. Use a tiny shell to capture it.
    const runner = new CliRunner({
      capability: "codex",
      command: "node",
      args: ["-e", "process.stdout.write(process.argv[1])", "--"],
      promptMode: "arg",
      // Replace the built prompt with our known JSON so stdout is deterministic.
      buildPromptOverride: () => RESULT_JSON
    });
    const output = await runner.run(SUMMARIZE, new AbortController().signal);
    assert.deepEqual(output, { summary: "s", priority: 1, rationale: "r" });
  });

  it("feeds the prompt over stdin in stdin mode", async () => {
    const runner = new CliRunner({
      capability: "claude",
      command: "cat",
      args: [],
      promptMode: "stdin",
      buildPromptOverride: () => RESULT_JSON
    });
    const output = await runner.run(SUMMARIZE, new AbortController().signal);
    assert.deepEqual(output, { summary: "s", priority: 1, rationale: "r" });
  });

  it("rejects when the CLI exits non-zero, including stderr", async () => {
    const runner = new CliRunner({
      capability: "codex",
      command: "node",
      args: ["-e", "process.stderr.write('bad cli'); process.exit(2)"],
      promptMode: "arg",
      buildPromptOverride: () => RESULT_JSON
    });
    await assert.rejects(runner.run(SUMMARIZE, new AbortController().signal), /bad cli|exited/);
  });

  it("kills the child on abort", async () => {
    const runner = new CliRunner({
      capability: "codex",
      // Sleep long enough that only an abort can end it.
      command: "node",
      args: ["-e", "setTimeout(() => {}, 60000)"],
      promptMode: "arg",
      buildPromptOverride: () => RESULT_JSON,
      cancelGraceMs: 50
    });
    const controller = new AbortController();
    const running = runner.run(SUMMARIZE, controller.signal);
    setTimeout(() => controller.abort(new Error("cancelled")), 20);
    await assert.rejects(running);
  });
});
