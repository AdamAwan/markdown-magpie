import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { LanguageModel } from "ai";
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

type ScriptedTurn = { toolCall: { toolName: string; input: unknown } } | { text: string };

// One MockLanguageModelV3 doGenerate result per scripted turn: a tool-call part
// (input is a STRINGIFIED JSON string in the V3 spec) or a final text part.
function scriptedModel(turns: ScriptedTurn[]): LanguageModel {
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined }
  };
  return new MockLanguageModelV3({
    doGenerate: turns.map((turn, index) =>
      "toolCall" in turn
        ? {
            content: [
              {
                type: "tool-call" as const,
                toolCallId: `call-${index}`,
                toolName: turn.toolCall.toolName,
                input: JSON.stringify(turn.toolCall.input)
              }
            ],
            finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
            usage,
            warnings: []
          }
        : {
            content: [{ type: "text" as const, text: turn.text }],
            finishReason: { unified: "stop" as const, raw: "stop" },
            usage,
            warnings: []
          }
    )
  });
}

describe("runSourceAgentJob", () => {
  it("lets the model read a source file and returns the parsed job output", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "magpie-agent-"));
    writeFileSync(path.join(root, "readme.md"), "statements are ingested via email and API");
    const model = scriptedModel([
      { toolCall: { toolName: "read_file", input: { path: "s1/readme.md" } } },
      { text: OUTPUT }
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
});
