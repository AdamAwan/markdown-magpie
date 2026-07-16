import { test } from "node:test";
import assert from "node:assert/strict";
import { callTool, resolveStdioAuthToken, tools } from "./main.js";

// Design-mandated guard (design §Testing strategy): auth-required stdio startup
// rejects a missing MCP_AUTH_TOKEN. resolveStdioAuthToken is the pure helper the
// startup path turns into a non-zero exit, so testing it locks the contract
// without spawning the process. Auth fails CLOSED: an unset/blank AUTH_REQUIRED
// keeps the token mandatory; only AUTH_REQUIRED=false disables it.
test("resolveStdioAuthToken throws when auth is required but the token is missing", () => {
  assert.throws(
    () => resolveStdioAuthToken({ AUTH_REQUIRED: "true" }),
    /MCP_AUTH_TOKEN is required unless AUTH_REQUIRED=false/
  );
});

test("resolveStdioAuthToken fails closed: unset AUTH_REQUIRED still requires the token", () => {
  assert.throws(() => resolveStdioAuthToken({}), /MCP_AUTH_TOKEN is required unless AUTH_REQUIRED=false/);
});

test("resolveStdioAuthToken returns the token when auth is required and present", () => {
  assert.equal(resolveStdioAuthToken({ AUTH_REQUIRED: "true", MCP_AUTH_TOKEN: "stdio-token" }), "stdio-token");
});

test("resolveStdioAuthToken returns undefined and never throws when auth is explicitly disabled", () => {
  assert.equal(resolveStdioAuthToken({ AUTH_REQUIRED: "false" }), undefined);
  // A stray token with auth disabled is still returned, keeping the disabled path
  // byte-identical to before.
  assert.equal(resolveStdioAuthToken({ AUTH_REQUIRED: "false", MCP_AUTH_TOKEN: "stray" }), "stray");
});

// ── questionnaire tools (stdio) ───────────────────────────────────────────────
//
// The stdio transport advertises the three questionnaire tools and its
// tools/call dispatch reaches the kb-client functions. The dispatch tests stub
// globalThis.fetch and assert on the downstream API path, which pins the
// tool → client-function wiring without a live API.

test("tools/list advertises the questionnaire tools", () => {
  const names = tools.map((tool) => tool.name);
  for (const name of ["kb_questionnaire_create", "kb_questionnaire_get", "kb_questionnaire_approve"]) {
    assert.ok(names.includes(name), `expected tools list to include ${name}`);
  }
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });

const questionnaireBody = {
  questionnaire: {
    id: "qn-1",
    name: "Q3 review",
    flowId: "magpie-support",
    status: "open",
    items: []
  }
};

// The MCP text-content envelope every tool returns; the JSON payload is in
// content[0].text.
function textPayload(result: unknown): unknown {
  const content = (result as { content: { type: string; text: string }[] }).content;
  assert.equal(content.length, 1);
  assert.equal(content[0].type, "text");
  return JSON.parse(content[0].text);
}

test("kb_questionnaire_create dispatches to the create route", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; method?: string }[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: typeof input === "string" ? input : input.toString(), method: init?.method });
    return jsonResponse(questionnaireBody, 201);
  }) as typeof fetch;

  try {
    const result = await callTool({
      name: "kb_questionnaire_create",
      arguments: { name: "Q3 review", flow: "magpie-support", questions: ["Do you encrypt data at rest?"] }
    });

    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith("/api/questionnaires"));
    assert.equal(calls[0].method, "POST");
    const payload = textPayload(result) as { id: string };
    assert.equal(payload.id, "qn-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("kb_questionnaire_get dispatches to the worksheet route", async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    urls.push(typeof input === "string" ? input : input.toString());
    return jsonResponse(questionnaireBody);
  }) as typeof fetch;

  try {
    const result = await callTool({ name: "kb_questionnaire_get", arguments: { questionnaire: "qn-1" } });

    assert.equal(urls.length, 1);
    assert.ok(urls[0].endsWith("/api/questionnaires/qn-1"));
    const payload = textPayload(result) as { id: string };
    assert.equal(payload.id, "qn-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("kb_questionnaire_approve dispatches to approve-reused (bulk) or the item route", async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);
    return jsonResponse(url.endsWith("/approve-reused") ? { approved: 3 } : { ok: true });
  }) as typeof fetch;

  try {
    const bulk = await callTool({ name: "kb_questionnaire_approve", arguments: { questionnaire: "qn-1" } });
    assert.ok(urls[0].endsWith("/api/questionnaires/qn-1/approve-reused"));
    assert.deepEqual(textPayload(bulk), { approved: 3 });

    const single = await callTool({
      name: "kb_questionnaire_approve",
      arguments: { questionnaire: "qn-1", item: "item-2" }
    });
    assert.ok(urls[1].endsWith("/api/questionnaires/qn-1/items/item-2/approve"));
    assert.deepEqual(textPayload(single), { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
