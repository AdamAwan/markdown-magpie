import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { JOB_TYPES, jobDefinition, type JobView, type JobType } from "@magpie/jobs";
import type { RetrievedSection, WatcherApi } from "../http-client.js";
import { CliRunner, type CliSpawn, type SpawnedCli } from "./cli.js";

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
    // The embedding router abstains, so CLI routing falls back to the chat router.
    routeByEmbedding: async () => ({ status: "abstain" }),
    proposalExecutionContext: async () => ({ proposal: {}, repository: {} }),
    reconcileGaps: async () => ({ ok: true }),
    verifyClosure: async () => ({ proposalId: "p", closureStatus: "verified_closed", perQuestion: [] }),
    runSourceSync: async () => ({ runIds: [] }),
    runFixPatrol: async () => ({ runId: "run-1", selectedCount: 0, findingCount: 0 }),
    runImprovePatrol: async () => ({ runId: "run-1", selectedCount: 0, enqueuedCount: 0 }),
    listOpenPullRequests: async () => [],
    getSourceCorpus: async () => [],
    ...overrides
  };
}

const SEED_OUTPUT = {
  title: "Statements Module",
  targetPath: "statements/overview.md",
  markdown: "# Statements\n\nGrounded content.",
  rationale: "Grounded in the Repo checkout."
};
const SEED_OUTPUT_JSON = JSON.stringify(SEED_OUTPUT);

function seedJob(provider: "codex" | "claude"): JobView {
  return job("draft_seed_document", {
    provider,
    flowId: "f1",
    coverage: ["statement ingestion"],
    sources: [{ id: "s1", name: "Repo", kind: "local", path: "unused-here" }]
  });
}

interface SpawnCall {
  command: string;
  args: string[];
  cwd?: string;
}

// Scripted stand-in for a spawned CLI: real streams so the runner's data
// listeners work, exit driven by the fake spawn below.
class FakeChild extends EventEmitter implements SpawnedCli {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  kill(): boolean {
    return true;
  }
}

// A CliSpawn that records every invocation, then emits the given stdout and a
// clean exit — no real process involved.
function fakeSpawn(calls: SpawnCall[], stdout: string): CliSpawn {
  return (command, args, options) => {
    calls.push({ command, args: [...args], ...(options.cwd !== undefined ? { cwd: options.cwd } : {}) });
    const child = new FakeChild();
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from(stdout));
      child.emit("close", 0);
    });
    return child;
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

  it("injects --model before the prompt in arg mode when a model is configured", async () => {
    // The script asserts the runner placed `--model <value>` ahead of the prompt.
    const runner = new CliRunner({
      capability: "claude",
      command: "node",
      args: [
        "-e",
        "const a = process.argv.slice(1); const i = a.indexOf('--model'); if (i < 0 || a[i + 1] !== 'my-model') process.exit(4); if (!a.at(-1).includes('\\\"summary\\\":\\\"s\\\"')) process.exit(5); process.stdout.write(JSON.stringify({ summary: 's', priority: 1, rationale: 'r' }));",
        "--"
      ],
      promptMode: "arg",
      model: "my-model",
      buildPromptOverride: () => RESULT_JSON
    });
    const output = await runner.run(SUMMARIZE, new AbortController().signal);
    assert.deepEqual(output, { summary: "s", priority: 1, rationale: "r" });
  });

  it("passes --model on the command line in stdin mode (prompt still over stdin)", async () => {
    const runner = new CliRunner({
      capability: "claude",
      command: "node",
      args: [
        "-e",
        "const a = process.argv.slice(1); const i = a.indexOf('--model'); if (i < 0 || a[i + 1] !== 'my-model') process.exit(4); let prompt = ''; process.stdin.on('data', c => prompt += c); process.stdin.on('end', () => { if (!prompt.includes('\\\"summary\\\":\\\"s\\\"')) process.exit(5); process.stdout.write(JSON.stringify({ summary: 's', priority: 1, rationale: 'r' })); });",
        "--"
      ],
      promptMode: "stdin",
      model: "my-model",
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

  it("derives reconcile_gap_clusters confirmed flags from one batched Claude CLI critic call", async () => {
    // The batched critic prompt lists every op by id; the CLI returns one verdict per id.
    const script = [
      "const prompt = process.argv.at(-1) || '';",
      "if (prompt.includes('Confirm or reject each independently')) {",
      "  process.stdout.write(JSON.stringify({ verdicts: [",
      "    { id: 'merge-0', confirmed: true },",
      "    { id: 'split-0', confirmed: false }",
      "  ] }));",
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

describe("CliRunner source-grounded seeding", () => {
  it("runs draft_seed_document inside the source workspace with hard read-only claude tools", async () => {
    const calls: SpawnCall[] = [];
    const runner = new CliRunner({
      capability: "claude",
      command: "claude",
      args: ["-p"],
      promptMode: "arg",
      model: "my-model",
      api: fakeApi(),
      agenticTimeoutMs: 600_000,
      prepareWorkspaces: async () => ({
        workspaces: [
          { sourceId: "s1", name: "Repo", rootDir: "/checkouts/s1" },
          { sourceId: "s2", name: "Docs", rootDir: "/checkouts/s2" }
        ],
        notes: []
      }),
      spawnOverride: fakeSpawn(calls, SEED_OUTPUT_JSON)
    });
    const output = await runner.run(seedJob("claude"), new AbortController().signal);
    assert.deepEqual(output, SEED_OUTPUT);

    const call = calls[0]!;
    // The primary workspace is the CLI's working directory.
    assert.equal(call.cwd, "/checkouts/s1");
    // --tools hard-removes everything but the read-only tools (verified live on
    // claude v2.1.201; --allowedTools alone does NOT block Bash).
    const toolsAt = call.args.indexOf("--tools");
    assert.ok(toolsAt >= 0, `expected --tools in ${call.args.join(" ")}`);
    assert.equal(call.args[toolsAt + 1], "Read,Grep,Glob");
    // --model must be consumed BEFORE the variadic read-only flags begin, or
    // --add-dir would swallow it as a directory value.
    assert.ok(call.args.indexOf("--model") >= 0 && call.args.indexOf("--model") < toolsAt);
    // Every workspace beyond the first is granted via a repeated --add-dir.
    const addDirAt = call.args.indexOf("--add-dir");
    assert.equal(call.args[addDirAt + 1], "/checkouts/s2");
    // claude's --tools/--add-dir are variadic and would swallow a trailing
    // positional prompt, so "--" must sit immediately before the prompt.
    assert.equal(call.args.at(-2), "--");
    assert.match(call.args.at(-1) ?? "", /Source repositories available/);
  });

  it("passes --sandbox read-only and --skip-git-repo-check for codex and lists extra workspaces in the prompt", async () => {
    const calls: SpawnCall[] = [];
    const runner = new CliRunner({
      capability: "codex",
      command: "codex",
      args: ["exec"],
      promptMode: "arg",
      api: fakeApi(),
      prepareWorkspaces: async () => ({
        workspaces: [
          { sourceId: "s1", name: "Repo", rootDir: "/checkouts/s1" },
          { sourceId: "s2", name: "Docs", rootDir: "/checkouts/s2" }
        ],
        notes: []
      }),
      spawnOverride: fakeSpawn(calls, SEED_OUTPUT_JSON)
    });
    const output = await runner.run(seedJob("codex"), new AbortController().signal);
    assert.deepEqual(output, SEED_OUTPUT);

    const call = calls[0]!;
    assert.equal(call.cwd, "/checkouts/s1");
    assert.deepEqual(call.args.slice(1, 4), ["--sandbox", "read-only", "--skip-git-repo-check"]);
    // codex read-only mode does not confine reads to cwd, so extra workspaces
    // need no flags — the prompt lists their roots instead.
    const promptArg = call.args.at(-1) ?? "";
    assert.match(promptArg, /\/checkouts\/s2/);
    // codex's prompt is a bare clap positional; `--` (honoured by clap) sits
    // immediately before it so a prompt beginning with `-`/`--` cannot be
    // misparsed as a flag or subcommand.
    assert.equal(call.args.at(-2), "--");
  });

  it("keeps the plain generative path for seed jobs with only non-fs sources", async () => {
    const calls: SpawnCall[] = [];
    const runner = new CliRunner({
      capability: "claude",
      command: "claude",
      args: ["-p"],
      promptMode: "arg",
      api: fakeApi(),
      prepareWorkspaces: async () => {
        throw new Error("must not be called for non-fs sources");
      },
      spawnOverride: fakeSpawn(calls, SEED_OUTPUT_JSON)
    });
    const nonFsJob = seedJob("claude");
    (nonFsJob.input as { sources: unknown }).sources = [
      { id: "i1", name: "Site", kind: "internet", url: "https://x.example" }
    ];
    const output = await runner.run(nonFsJob, new AbortController().signal);
    assert.deepEqual(output, SEED_OUTPUT);

    const call = calls[0]!;
    assert.equal(call.cwd, undefined);
    assert.equal(call.args.includes("--tools"), false);
    assert.equal(call.args.includes("--"), false);
  });

  it("escalates SIGTERM to SIGKILL when a source-grounded run times out", async () => {
    const signals: NodeJS.Signals[] = [];
    // A hung agent: records the kill signals it receives and never exits, so the
    // grace-window SIGKILL is the only thing that can reap it.
    const hangingSpawn: CliSpawn = () => {
      const child = new FakeChild();
      child.kill = (signal?: NodeJS.Signals): boolean => {
        signals.push(signal ?? "SIGTERM");
        return true;
      };
      return child;
    };
    const runner = new CliRunner({
      capability: "claude",
      command: "claude",
      args: ["-p"],
      promptMode: "arg",
      api: fakeApi(),
      agenticTimeoutMs: 10,
      cancelGraceMs: 10,
      prepareWorkspaces: async () => ({
        workspaces: [{ sourceId: "s1", name: "Repo", rootDir: "/checkouts/s1" }],
        notes: []
      }),
      spawnOverride: hangingSpawn
    });
    await assert.rejects(runner.run(seedJob("claude"), new AbortController().signal), /timed out/);
    // Wait past the grace window so the escalation timer fires.
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  });
});
