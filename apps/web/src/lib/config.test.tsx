import assert from "node:assert/strict";
import test from "node:test";
import { extractModelInfo, knowledgeFlowLabels, knowledgeFlows } from "./config";
import type { ConfiguredKnowledgeRepository, RuntimeConfig } from "./types";

// Minimal valid RuntimeConfig; tests override only the `providers`/`knowledge`
// slices the functions under test actually read.
function config(overrides: {
  providers?: Record<string, unknown>;
  knowledge?: Partial<RuntimeConfig["knowledge"]>;
}): RuntimeConfig {
  return {
    api: {},
    stores: {},
    knowledge: { repositoryPath: null, ...overrides.knowledge },
    providers: overrides.providers ?? {},
    aiRuntime: { provider: "openai-compatible" },
    retrieval: { mode: "hybrid", reason: "", embeddingProvider: null },
    watcher: {}
  };
}

test("extractModelInfo returns an empty object when there is no config", () => {
  assert.deepEqual(extractModelInfo(undefined), {});
});

test("extractModelInfo reads chat and embedding details from an OpenAI-compatible provider", () => {
  const info = extractModelInfo(
    config({
      providers: {
        openAiCompatible: {
          model: "gpt-4o",
          baseUrl: "https://api.openai.com/v1",
          embeddingModel: "text-embedding-3-large",
          embeddingBaseUrl: "https://api.deepseek.com/v1"
        }
      }
    })
  );

  assert.deepEqual(info, {
    chatModel: "gpt-4o",
    chatHost: "OpenAI",
    embeddingModel: "text-embedding-3-large",
    embeddingHost: "DeepSeek"
  });
});

test("extractModelInfo shares the chat host for embeddings when no embedding base URL is set", () => {
  const info = extractModelInfo(
    config({
      providers: {
        openAiCompatible: {
          model: "local",
          baseUrl: "https://openrouter.ai/api/v1",
          embeddingModel: "embed"
        }
      }
    })
  );

  assert.equal(info.chatHost, "OpenRouter");
  assert.equal(info.embeddingHost, "OpenRouter");
});

test("extractModelInfo maps known hostnames and falls back to the raw hostname", () => {
  const cases: Array<[string, string]> = [
    ["https://api.deepseek.com/v1", "DeepSeek"],
    ["https://openrouter.ai/api/v1", "OpenRouter"],
    ["https://api.openai.com/v1", "OpenAI"],
    ["https://api.anthropic.com/v1", "Anthropic"],
    ["https://llm.internal.acme.dev/v1", "llm.internal.acme.dev"]
  ];
  for (const [baseUrl, expectedHost] of cases) {
    const info = extractModelInfo(config({ providers: { openAiCompatible: { model: "m", baseUrl } } }));
    assert.equal(info.chatHost, expectedHost, baseUrl);
  }
});

test("extractModelInfo returns the raw string when the base URL is unparseable", () => {
  const info = extractModelInfo(config({ providers: { openAiCompatible: { model: "m", baseUrl: "not a url" } } }));
  assert.equal(info.chatHost, "not a url");
});

test("extractModelInfo labels Azure OpenAI deployments", () => {
  const info = extractModelInfo(
    config({
      providers: {
        azureOpenAi: { chatDeployment: "gpt-4o-chat", embeddingDeployment: "ada-embed" }
      }
    })
  );

  assert.deepEqual(info, {
    chatModel: "gpt-4o-chat",
    chatHost: "Azure OpenAI",
    embeddingModel: "ada-embed",
    embeddingHost: "Azure OpenAI"
  });
});

test("extractModelInfo ignores non-string provider fields", () => {
  const info = extractModelInfo(config({ providers: { openAiCompatible: { model: 42, baseUrl: null } } }));
  assert.deepEqual(info, {});
});

const flow = { id: "flow-a", name: "Flow A", sourceIds: ["s1"], destinationId: "dest-a" };

test("knowledgeFlows returns the configured flows when present", () => {
  const flows = knowledgeFlows(config({ knowledge: { repositoryPath: null, flows: [flow] } }));
  assert.deepEqual(flows, [flow]);
});

test("knowledgeFlows derives flows from destinations and attaches all source ids", () => {
  const destinations: ConfiguredKnowledgeRepository[] = [
    { id: "d1", name: "Docs" },
    { id: "d2", name: "Wiki" }
  ];
  const sources: ConfiguredKnowledgeRepository[] = [
    { id: "s1", name: "Repo" },
    { id: "s2", name: "Site" }
  ];
  const flows = knowledgeFlows(config({ knowledge: { repositoryPath: null, destinations, sources } }));

  assert.deepEqual(flows, [
    { id: "d1", name: "Docs", sourceIds: ["s1", "s2"], destinationId: "d1" },
    { id: "d2", name: "Wiki", sourceIds: ["s1", "s2"], destinationId: "d2" }
  ]);
});

test("knowledgeFlows falls back to repositories when no destinations are configured", () => {
  const repositories: ConfiguredKnowledgeRepository[] = [{ id: "r1", name: "Legacy" }];
  const flows = knowledgeFlows(config({ knowledge: { repositoryPath: null, repositories } }));
  assert.deepEqual(flows, [{ id: "r1", name: "Legacy", sourceIds: [], destinationId: "r1" }]);
});

test("knowledgeFlows returns an empty list when nothing is configured", () => {
  assert.deepEqual(knowledgeFlows(undefined), []);
  assert.deepEqual(knowledgeFlows(config({})), []);
});

test("knowledgeFlowLabels maps flow ids to display names", () => {
  const labels = knowledgeFlowLabels(
    config({
      knowledge: {
        repositoryPath: null,
        flows: [flow, { id: "flow-b", name: "Flow B", sourceIds: [], destinationId: "dest-b" }]
      }
    })
  );
  assert.deepEqual(labels, { "flow-a": "Flow A", "flow-b": "Flow B" });
});
