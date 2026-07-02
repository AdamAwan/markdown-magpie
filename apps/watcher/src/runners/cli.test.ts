import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JOB_TYPES, jobDefinition, type JobView, type JobType } from "@magpie/jobs";
import type { RetrievedSection, WatcherApi } from "../http-client.js";
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

function cliProviderJobTypes(): JobType[] {
  return JOB_TYPES.filter((type) => {
    try {
      return jobDefinition(type).requiredCapability({ provider: "codex" }) === "codex";
    } catch {
      return false;
    }
  });
}

const SUMMARIZE = job("summarize_gap", { questions: ["q"], citedSections: [] });
const RESULT_JSON = JSON.stringify({ summary: "s", priority: 1, rationale: "r" });
const SECTIONS: RetrievedSection[] = [
  {
    sectionId: "doc-1#deploy",
    documentId: "doc-1",
    anchor: "deploy",
    path: "ops/deploy.md",
    heading: "Deploy",
    content: "Run the deploy script.",
    relevance: 0.9
  }
];

function fakeApi(overrides: Partial<WatcherApi> = {}): WatcherApi {
  return {
    claim: async () => undefined,
    heartbeat: async () => ({ cancelled: false }),
    complete: async () => undefined,
    fail: async () => undefined,
    retrieve: async () => SECTIONS,
    proposalExecutionContext: async () => ({ proposal: {}, repository: {} }),
    reconcileGaps: async () => ({ ok: true }),
    runSourceSync: async () => ({ runIds: [] }),
    runFixPatrol: async () => ({ runId: "run-1", selectedCount: 0, findingCount: 0 }),
    runImprovePatrol: async () => ({ runId: "run-1", selectedCount: 0, enqueuedCount: 0 }),
    listOpenPullRequests: async () => [],
    ...overrides
  };
}

describe("CliRunner", () => {
  it("exposes its provider capability and supports AI job types", () => {
    const runner = new CliRunner({ capability: "codex", command: "true", args: [], promptMode: "arg" });
    assert.equal(runner.capability, "codex");
    for (const type of cliProviderJobTypes()) {
      assert.ok(runner.supports(type), `CLI runner should support provider job type ${type}`);
    }
    assert.ok(!runner.supports("publish_proposal"));
  });

  it("passes the prompt as the final arg in arg mode and parses JSON stdout", async () => {
    // The tiny Node script verifies the prompt reached the CLI, then returns
    // deterministic JSON for the runner to parse.
    const runner = new CliRunner({
      capability: "codex",
      command: "node",
      args: [
        "-e",
        "const prompt = process.argv.at(-1) || ''; if (!prompt.includes('\\\"summary\\\":\\\"s\\\"')) process.exit(3); process.stdout.write(JSON.stringify({ summary: 's', priority: 1, rationale: 'r' }));",
        "--"
      ],
      promptMode: "arg",
      // Replace the built prompt with known JSON so prompt delivery is deterministic.
      buildPromptOverride: () => RESULT_JSON
    });
    const output = await runner.run(SUMMARIZE, new AbortController().signal);
    assert.deepEqual(output, { summary: "s", priority: 1, rationale: "r" });
  });

  it("feeds the prompt over stdin in stdin mode", async () => {
    const runner = new CliRunner({
      capability: "claude",
      command: "node",
      args: [
        "-e",
        "let prompt = ''; process.stdin.on('data', chunk => prompt += chunk); process.stdin.on('end', () => { if (!prompt.includes('\\\"summary\\\":\\\"s\\\"')) process.exit(3); process.stdout.write(JSON.stringify({ summary: 's', priority: 1, rationale: 'r' })); });"
      ],
      promptMode: "stdin",
      buildPromptOverride: () => RESULT_JSON
    });
    const output = await runner.run(SUMMARIZE, new AbortController().signal);
    assert.deepEqual(output, { summary: "s", priority: 1, rationale: "r" });
  });

  it("routes, retrieves, answers, and derives citations for answer_question", async () => {
    let retrievedFlow: string | undefined = "unset";
    const api = fakeApi({
      retrieve: async (_question, flowId) => {
        retrievedFlow = flowId;
        return SECTIONS;
      }
    });
    const script = [
      "const prompt = process.argv.at(-1) || '';",
      "if (prompt.includes('Answer under review:')) {",
      "  process.stdout.write(JSON.stringify({ grounded: true, unsupportedClaims: [] }));",
      "} else if (prompt.includes('Context:')) {",
      "  process.stdout.write(JSON.stringify({ answer: 'Run the deploy script.', confidence: 'high', isKnowledgeGap: false }));",
      "} else {",
      "  process.stdout.write(JSON.stringify({ flowId: 'flow-b', confidence: 'high' }));",
      "}"
    ].join("\n");
    const runner = new CliRunner({
      capability: "claude",
      command: "node",
      args: ["-e", script, "--"],
      promptMode: "arg",
      api
    });
    const output = (await runner.run(
      job("answer_question", {
        provider: "claude",
        question: "How do I deploy?",
        flows: [
          { id: "flow-a", name: "Alpha" },
          { id: "flow-b", name: "Beta" }
        ],
        expectedOutput: "answer_result"
      }),
      new AbortController().signal
    )) as { citations: unknown[]; flowId?: string };

    assert.equal(retrievedFlow, "flow-b");
    assert.equal(output.flowId, "flow-b");
    assert.equal(output.citations.length, 1);
  });

  it("derives reconcile_gap_clusters confirmed flags from Claude CLI critic calls", async () => {
    const script = [
      "const prompt = process.argv.at(-1) || '';",
      "if (prompt.includes('Proposed merge')) {",
      "  process.stdout.write(JSON.stringify({ confirmed: true, rationale: 'one doc covers both' }));",
      "} else if (prompt.includes('Proposed split')) {",
      "  process.stdout.write(JSON.stringify({ confirmed: false, rationale: 'independent topics' }));",
      "} else {",
      "  process.stdout.write(JSON.stringify({",
      "    merges: [{ clusterIds: ['c1', 'c2'], rationale: 'merge them' }],",
      "    splits: [{ clusterId: 'c3', children: [{ gapIds: ['g1'] }, { gapIds: ['g2'] }], rationale: 'split it' }]",
      "  }));",
      "}"
    ].join("\n");
    const runner = new CliRunner({
      capability: "claude",
      command: "node",
      args: ["-e", script, "--"],
      promptMode: "arg",
      api: fakeApi()
    });
    const output = (await runner.run(
      job("reconcile_gap_clusters", {
        provider: "claude",
        clusters: [
          { id: "c1", title: "Alpha" },
          { id: "c2", title: "Beta" },
          { id: "c3", title: "Gamma" }
        ]
      }),
      new AbortController().signal
    )) as {
      merges: Array<{ clusterIds: string[]; confirmed: boolean }>;
      splits: Array<{ clusterId: string; confirmed: boolean }>;
    };

    assert.equal(output.merges.length, 1);
    assert.equal(output.merges[0].confirmed, true);
    assert.deepEqual(output.merges[0].clusterIds, ["c1", "c2"]);
    assert.equal(output.splits.length, 1);
    assert.equal(output.splits[0].confirmed, false);
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
