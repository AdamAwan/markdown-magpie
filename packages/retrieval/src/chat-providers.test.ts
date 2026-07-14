import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { OpenAICompatibleChatProvider } from "./chat-providers.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function completionResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("OpenAICompatibleChatProvider usage reporting (#241)", () => {
  const provider = new OpenAICompatibleChatProvider({
    apiKey: "k",
    baseUrl: "https://api.example.com/v1",
    model: "m"
  });

  it("surfaces the OpenAI-style usage block on the response", async () => {
    globalThis.fetch = (async () =>
      completionResponse({
        choices: [{ message: { content: "hello" } }],
        usage: { prompt_tokens: 120, completion_tokens: 34, total_tokens: 154 }
      })) as unknown as typeof fetch;

    const response = await provider.complete({ system: "s", messages: [{ role: "user", content: "q" }] });

    assert.equal(response.content, "hello");
    assert.deepEqual(response.usage, { inputTokens: 120, outputTokens: 34, totalTokens: 154 });
  });

  it("omits usage entirely when the provider reports none", async () => {
    globalThis.fetch = (async () =>
      completionResponse({ choices: [{ message: { content: "hello" } }] })) as unknown as typeof fetch;

    const response = await provider.complete({ system: "s", messages: [{ role: "user", content: "q" }] });

    assert.equal(response.content, "hello");
    assert.equal(response.usage, undefined);
  });

  it("drops malformed counts and keeps the well-formed ones", async () => {
    globalThis.fetch = (async () =>
      completionResponse({
        choices: [{ message: { content: "hello" } }],
        usage: { prompt_tokens: "not-a-number", completion_tokens: -3, total_tokens: 42 }
      })) as unknown as typeof fetch;

    const response = await provider.complete({ system: "s", messages: [{ role: "user", content: "q" }] });

    assert.deepEqual(response.usage, { totalTokens: 42 });
  });
});
