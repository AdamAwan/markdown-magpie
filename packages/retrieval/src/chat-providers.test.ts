import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { AzureOpenAIChatProvider, DEFAULT_CHAT_TEMPERATURE, OpenAICompatibleChatProvider } from "./chat-providers.js";

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

// #364: reasoning deployments (GPT-5-class, o-series) reject an explicit
// temperature with HTTP 400, so omission has to be expressible — while every
// existing deployment keeps getting the byte-for-byte identical 0.2 body.
describe("chat provider temperature (#364)", () => {
  function captureBody(): () => Record<string, unknown> {
    let captured: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      captured = JSON.parse(String(init.body)) as Record<string, unknown>;
      return completionResponse({ choices: [{ message: { content: "hello" } }] });
    }) as unknown as typeof fetch;
    return () => captured;
  }

  const openaiConfig = { apiKey: "k", baseUrl: "https://api.example.com/v1", model: "m" };
  const azureConfig = {
    apiKey: "k",
    azureEndpoint: "https://example.openai.azure.com",
    azureDeployment: "d",
    azureApiVersion: "2024-10-21"
  };
  const request = { system: "s", messages: [{ role: "user" as const, content: "q" }] };

  it("sends the 0.2 default when the openai-compatible config leaves it unset", async () => {
    const body = captureBody();
    await new OpenAICompatibleChatProvider(openaiConfig).complete(request);
    assert.equal(body().temperature, DEFAULT_CHAT_TEMPERATURE);
  });

  it("omits temperature entirely when the openai-compatible config is null", async () => {
    const body = captureBody();
    await new OpenAICompatibleChatProvider({ ...openaiConfig, temperature: null }).complete(request);
    assert.equal("temperature" in body(), false);
  });

  it("sends the override when the openai-compatible config gives a number", async () => {
    const body = captureBody();
    await new OpenAICompatibleChatProvider({ ...openaiConfig, temperature: 0.9 }).complete(request);
    assert.equal(body().temperature, 0.9);
  });

  it("sends the 0.2 default when the azure config leaves it unset", async () => {
    const body = captureBody();
    await new AzureOpenAIChatProvider(azureConfig).complete(request);
    assert.equal(body().temperature, DEFAULT_CHAT_TEMPERATURE);
  });

  it("omits temperature entirely when the azure config is null", async () => {
    const body = captureBody();
    await new AzureOpenAIChatProvider({ ...azureConfig, temperature: null }).complete(request);
    assert.equal("temperature" in body(), false);
  });

  it("sends the override when the azure config gives a number", async () => {
    const body = captureBody();
    await new AzureOpenAIChatProvider({ ...azureConfig, temperature: 0 }).complete(request);
    assert.equal(body().temperature, 0);
  });
});
