import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { JobView } from "@magpie/jobs";
import { BoundedOutput, killProcessTree, processTreeSpawnOptions, TailOutput } from "./cli-process.js";
import { CliRunner } from "./cli.js";
import { normalizePromptMode } from "./index.js";

// Real-process tests for the CLI runner's bounds (docs/ai-jobs.md J80, J85).
// Each "fake CLI" is a small node script run as `node <script> <runner args…>`,
// so the runner's own isolation args land in the script's argv harmlessly.

const RESULT_JSON = JSON.stringify({ summary: "s", priority: 1, rationale: "r" });
const SUMMARIZE: JobView = {
  id: "j",
  type: "summarize_gap",
  queueName: "summarize_gap",
  deadLetter: false,
  state: "active",
  input: { questions: ["q"], citedSections: [] },
  retryCount: 0,
  retryLimit: 3,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  expireInSeconds: 300
};

function script(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "magpie-fake-cli-"));
  const file = join(dir, "cli.mjs");
  writeFileSync(file, source);
  return file;
}

function fakeCli(source: string, overrides: Partial<ConstructorParameters<typeof CliRunner>[0]> = {}): CliRunner {
  return new CliRunner({
    capability: "codex",
    command: process.execPath,
    args: [script(source)],
    promptMode: "stdin",
    // Forward the test process's env so `node` itself resolves; the runner
    // still applies its allowlist on top.
    spawnEnv: process.env,
    ...overrides
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
}

const BIG_PROMPT = `${"lorem ipsum ".repeat(25_000)}END-OF-PROMPT`;

describe("CLI prompt delivery (J80)", () => {
  it("defaults to stdin and only uses argv when explicitly asked", () => {
    assert.equal(normalizePromptMode(undefined), "stdin");
    assert.equal(normalizePromptMode(""), "stdin");
    assert.equal(normalizePromptMode("stdin"), "stdin");
    assert.equal(normalizePromptMode(" ARG "), "arg");
  });

  it("delivers a >200KB prompt over stdin", async () => {
    assert.ok(Buffer.byteLength(BIG_PROMPT) > 200_000);
    const runner = fakeCli(
      `let prompt = "";
       process.stdin.on("data", (chunk) => (prompt += chunk));
       process.stdin.on("end", () => {
         if (prompt.length < 200000 || !prompt.endsWith("END-OF-PROMPT")) process.exit(3);
         process.stdout.write(${JSON.stringify(RESULT_JSON)});
       });`,
      { buildPromptOverride: () => BIG_PROMPT }
    );
    const output = await runner.run(SUMMARIZE, new AbortController().signal);
    assert.deepEqual(output, JSON.parse(RESULT_JSON));
  });

  it("documents why: the same prompt as one argv element cannot even be spawned on Linux", async (t) => {
    if (process.platform !== "linux") {
      t.skip("the 128KB per-argument limit (MAX_ARG_STRLEN) is Linux-specific");
      return;
    }
    const runner = fakeCli(`process.stdout.write(${JSON.stringify(RESULT_JSON)});`, {
      promptMode: "arg",
      buildPromptOverride: () => BIG_PROMPT
    });
    await assert.rejects(runner.run(SUMMARIZE, new AbortController().signal), /E2BIG/);
  });
});

describe("CLI output bounds and process-tree kill (J85)", () => {
  it("stops a runaway-output child and fails clearly", async () => {
    const runner = fakeCli(
      `const line = "x".repeat(64 * 1024);
       const pump = () => { while (process.stdout.write(line)) {} process.stdout.once("drain", pump); };
       pump();`,
      { maxOutputBytes: 1024 * 1024, cancelGraceMs: 100, buildPromptOverride: () => "p" }
    );
    const started = Date.now();
    await assert.rejects(runner.run(SUMMARIZE, new AbortController().signal), /output exceeded 1048576 bytes/);
    assert.ok(Date.now() - started < 10_000, "failed promptly rather than buffering forever");
  });

  it("keeps only the tail of a chatty stderr in the failure message", async () => {
    const runner = fakeCli(
      `process.stderr.write("noise ".repeat(100000)); process.stderr.write("FINAL ERROR"); process.exitCode = 2;`,
      { buildPromptOverride: () => "p" }
    );
    await assert.rejects(runner.run(SUMMARIZE, new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /exited with 2: …/);
      assert.match(error.message, /FINAL ERROR$/);
      assert.ok(error.message.length < 2_100, `bounded message (${error.message.length} chars)`);
      return true;
    });
  });

  it("kills a grandchild that ignores SIGTERM when the run times out", async (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX process groups; Windows uses taskkill /T");
      return;
    }
    const pidFile = join(mkdtempSync(join(tmpdir(), "magpie-grandchild-")), "pid");
    const runner = fakeCli(
      `import { spawn } from "node:child_process";
       import { writeFileSync } from "node:fs";
       process.on("SIGTERM", () => {});
       const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });
       writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
       setInterval(() => {}, 1000);`,
      { timeoutMs: 500, cancelGraceMs: 200, buildPromptOverride: () => "p" }
    );
    await assert.rejects(runner.run(SUMMARIZE, new AbortController().signal), /timed out after 500ms/);
    assert.ok(existsSync(pidFile), "the fake CLI started its grandchild");
    const grandchildPid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(
      await waitFor(() => !alive(grandchildPid), 3_000),
      "the SIGTERM-ignoring grandchild was SIGKILLed with its process group"
    );
  });

  it("kills the tree on abort too", async (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX process groups; Windows uses taskkill /T");
      return;
    }
    const pidFile = join(mkdtempSync(join(tmpdir(), "magpie-grandchild-")), "pid");
    const runner = fakeCli(
      `import { spawn } from "node:child_process";
       import { writeFileSync } from "node:fs";
       const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "inherit" });
       writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
       setInterval(() => {}, 1000);`,
      { cancelGraceMs: 200, buildPromptOverride: () => "p" }
    );
    const controller = new AbortController();
    const running = runner.run(SUMMARIZE, controller.signal);
    assert.ok(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "", 5_000));
    controller.abort(new Error("cancelled"));
    await assert.rejects(running, /aborted/);
    const grandchildPid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(await waitFor(() => !alive(grandchildPid), 3_000), "the grandchild died with the group");
  });
});

describe("cli-process helpers", () => {
  it("BoundedOutput keeps at most the cap and reports the overflow", () => {
    const output = new BoundedOutput(5);
    assert.equal(output.push(Buffer.from("abc")), true);
    assert.equal(output.push(Buffer.from("defg")), false);
    assert.equal(output.exceeded, true);
    assert.equal(output.text(), "abcde");
    assert.equal(output.push(Buffer.from("h")), false);
  });

  it("TailOutput keeps only the last bytes", () => {
    const output = new TailOutput(4);
    output.push(Buffer.from("abc"));
    output.push(Buffer.from("defg"));
    assert.equal(output.text(), "…defg");
    const small = new TailOutput(10);
    small.push(Buffer.from("ok"));
    assert.equal(small.text(), "ok");
  });

  it("detaches on POSIX only, and falls back to the direct child without a pid", () => {
    assert.deepEqual(processTreeSpawnOptions("linux"), { detached: true, windowsHide: true });
    assert.deepEqual(processTreeSpawnOptions("win32"), { detached: false, windowsHide: true });
    const signals: Array<NodeJS.Signals | undefined> = [];
    killProcessTree({ pid: undefined, kill: (signal) => signals.push(signal) > 0 }, "SIGTERM");
    assert.deepEqual(signals, ["SIGTERM"]);
  });

  it("signals the whole group of a detached child", async (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX process groups");
      return;
    }
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      ...processTreeSpawnOptions()
    });
    const exited = new Promise<NodeJS.Signals | null>((resolve) =>
      child.on("exit", (_code, signal) => resolve(signal))
    );
    killProcessTree(child, "SIGKILL");
    assert.equal(await exited, "SIGKILL");
  });
});
