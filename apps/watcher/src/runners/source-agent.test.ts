import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import type { JobView } from "@magpie/jobs";
import { runSourceAgentJob } from "./source-agent.js";

const OUTPUT = JSON.stringify({
  title: "Statements Module",
  targetPath: "statements/overview.md",
  markdown: "---\ntitle: Statements Module\nstatus: draft\n---\n\n# Statements\n\nGrounded content.",
  rationale: "Grounded in s1/readme.md."
});

function seedJob(): JobView {
  return {
    id: "job-1",
    type: "draft_seed_document",
    queueName: "draft_seed_document",
    deadLetter: false,
    state: "active",
    input: {
      provider: "openai-compatible",
      flowId: "f1",
      coverage: ["statement ingestion"],
      sources: [{ id: "s1", name: "Repo", kind: "local", path: "unused-here" }]
    },
    retryCount: 0,
    retryLimit: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expireInSeconds: 300
  };
}

type ScriptedTurn =
  { toolCall: { toolName: string; input: unknown } } | { text: string | ((conversation: string) => string) };

// One MockLanguageModelV3 doGenerate result per scripted turn: a tool-call part
// (input is a STRINGIFIED JSON string in the V3 spec) or a final text part. A
// text turn may be a function of the serialised conversation so far, so a test
// can emit valid output only when the model really saw a given tool result — a
// turn that answers unconditionally would pass even with broken tool wiring. An
// unscripted extra call throws, failing the test loudly.
function scriptedModel(turns: ScriptedTurn[]): MockLanguageModelV3 {
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined }
  };
  let calls = 0;
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      const turn = turns[calls];
      calls += 1;
      if (!turn) {
        throw new Error(`model called ${calls} time(s) but only ${turns.length} turn(s) are scripted`);
      }
      if ("toolCall" in turn) {
        return {
          content: [
            {
              type: "tool-call" as const,
              toolCallId: `call-${calls - 1}`,
              toolName: turn.toolCall.toolName,
              input: JSON.stringify(turn.toolCall.input)
            }
          ],
          finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
          usage,
          warnings: []
        };
      }
      const text = typeof turn.text === "function" ? turn.text(JSON.stringify(options.prompt)) : turn.text;
      return {
        content: [{ type: "text" as const, text }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage,
        warnings: []
      };
    }
  });
}

describe("runSourceAgentJob", () => {
  it("lets the model read a source file and returns the parsed job output", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "magpie-agent-"));
    writeFileSync(path.join(root, "readme.md"), "statements are ingested via email and API");
    const model = scriptedModel([
      { toolCall: { toolName: "read_file", input: { path: "s1/readme.md" } } },
      {
        // Only answer once the file's actual content has come back through the
        // tool result — proving read_file really executed against the temp dir.
        text: (conversation) =>
          conversation.includes("statements are ingested via email and API")
            ? OUTPUT
            : "the read_file result never reached the model"
      }
    ]);
    const result = await runSourceAgentJob({
      job: seedJob(),
      model,
      workspaces: [{ sourceId: "s1", name: "Repo", rootDir: root }],
      notes: [],
      signal: new AbortController().signal
    });
    assert.equal((result as { title: string }).title, "Statements Module");
    assert.equal(model.doGenerateCalls.length, 2);
  });

  it("reports the loop's aggregate token usage through onUsage (#241)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "magpie-agent-"));
    writeFileSync(path.join(root, "readme.md"), "statements are ingested via email and API");
    const model = scriptedModel([
      { toolCall: { toolName: "read_file", input: { path: "s1/readme.md" } } },
      { text: OUTPUT }
    ]);
    const readings: Array<{ inputTokens?: number; outputTokens?: number }> = [];
    await runSourceAgentJob({
      job: seedJob(),
      model,
      workspaces: [{ sourceId: "s1", name: "Repo", rootDir: root }],
      notes: [],
      signal: new AbortController().signal,
      onUsage: (usage) => readings.push(usage)
    });
    // The scripted model reports 1 input + 1 output token per turn; two turns
    // ran, and the loop reports the aggregate once.
    assert.equal(readings.length, 1);
    assert.equal(readings[0].inputTokens, 2);
    assert.equal(readings[0].outputTokens, 2);
  });

  it("shows tool misuse to the model as an error result so it can recover", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "magpie-agent-"));
    writeFileSync(path.join(root, "readme.md"), "statements are ingested via email and API");
    const model = scriptedModel([
      { toolCall: { toolName: "read_file", input: { path: "s1/../outside.md" } } },
      {
        text: (conversation) =>
          conversation.includes("ERROR: path escapes the source workspace")
            ? OUTPUT
            : "the SourceToolError was not rendered to the model"
      }
    ]);
    const result = await runSourceAgentJob({
      job: seedJob(),
      model,
      workspaces: [{ sourceId: "s1", name: "Repo", rootDir: root }],
      notes: [],
      signal: new AbortController().signal
    });
    assert.equal((result as { title: string }).title, "Statements Module");
  });

  it("wires fetch_url for allowlisted internet sources and renders its refusals to the model (#242)", async () => {
    // No network needed: an off-allowlist URL is refused before any fetch, and
    // that refusal coming back as an ERROR tool result proves the fetch_url tool
    // is wired into the loop with the source's allowlist.
    const model = scriptedModel([
      { toolCall: { toolName: "fetch_url", input: { url: "https://evil.example.com/x" } } },
      {
        // The conversation is JSON-serialised (quotes escaped), so match a
        // quote-free fragment of the refusal.
        text: (conversation) =>
          conversation.includes("is not on the fetch allowlist (allowed: docs.x.example)")
            ? OUTPUT
            : "the fetch_url refusal was not rendered to the model"
      }
    ]);
    const result = await runSourceAgentJob({
      job: seedJob(),
      model,
      workspaces: [],
      notes: [],
      fetchable: [
        { sourceId: "i1", name: "Vendor docs", url: "https://docs.x.example", allowedHosts: ["docs.x.example"] }
      ],
      signal: new AbortController().signal
    });
    assert.equal((result as { title: string }).title, "Statements Module");
  });

  it("fails the job on an infrastructure fault instead of drafting un-grounded", async () => {
    // A workspace whose rootDir does not exist makes read_file hit a raw ENOENT —
    // an infrastructure fault, not model misuse. The job must reject with that
    // error and the model must not get another turn (which would otherwise let it
    // draft from the rendered error text).
    const missingRoot = path.join(mkdtempSync(path.join(tmpdir(), "magpie-agent-")), "does-not-exist");
    const model = scriptedModel([
      { toolCall: { toolName: "read_file", input: { path: "s1/readme.md" } } },
      { text: OUTPUT }
    ]);
    await assert.rejects(
      runSourceAgentJob({
        job: seedJob(),
        model,
        workspaces: [{ sourceId: "s1", name: "Repo", rootDir: missingRoot }],
        notes: [],
        signal: new AbortController().signal
      }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT"
    );
    assert.equal(model.doGenerateCalls.length, 1, "the model got no turn after the infrastructure fault");
  });
});
