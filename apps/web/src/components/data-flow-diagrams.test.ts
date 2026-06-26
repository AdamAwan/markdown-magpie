import assert from "node:assert/strict";
import test from "node:test";
import { buildDataFlowDiagram, FLOW_TABS } from "./data-flow-diagrams";

const modelInfo = {
  chatProvider: "openai",
  chatModel: "gpt-5",
  chatHost: "OpenAI",
  embeddingProvider: "openai",
  embeddingModel: "text-embedding-3-large",
  embeddingHost: "OpenAI"
};

test("exports all data-flow diagrams as BeautifulMermaid-compatible Mermaid source", () => {
  for (const flow of FLOW_TABS) {
    const graph = buildDataFlowDiagram(flow.key, modelInfo);

    assert.doesNotMatch(graph, /<[^>]+>/, `${flow.key} should not contain HTML labels`);
    assert.doesNotMatch(graph, /\bstyle\s+\w+/i, `${flow.key} should not contain style directives`);
    assert.doesNotMatch(graph, /<br\s*\/?>/i, `${flow.key} should not contain HTML line breaks`);
    assert.match(graph, /^(graph|sequenceDiagram)/, `${flow.key} should start with a supported diagram type`);
  }
});
