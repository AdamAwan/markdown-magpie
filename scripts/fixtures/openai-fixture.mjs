#!/usr/bin/env node
// Deterministic OpenAI-compatible chat fixture for the Task 14 queue-lifecycle
// E2E. This is a TEST-ONLY server, selected explicitly via
// OPENAI_COMPATIBLE_BASE_URL — it is NOT a product chat provider.
//
// Why a chat fixture (not a CLI fixture as the original plan sketched): the
// answer_question job runs ONLY through the watcher's ChatRunner (route ->
// POST /api/retrieve -> answer). The CliRunner deliberately excludes
// answer_question, so a `codex` CLI fixture could never execute it. Driving the
// E2E through an openai-compatible chat provider exercises the REAL answer path.
//
// It implements exactly the surface the OpenAICompatibleChatProvider calls:
//   POST <base>/chat/completions  (base ends in /v1, so the path is /v1/chat/completions)
//
// Per answer_question job it receives at least two completion requests:
//   1. a ROUTING request  — system prompt asks to "route a user question"
//   2. an ANSWER request   — system prompt is the answer-question instructions
// It distinguishes them by the system prompt text and returns schema-valid JSON
// the watcher can parse (routing -> {flowId,...}; answer -> {answer,confidence,...}).
//
// Behaviour markers are carried in the QUESTION TEXT (which appears in the user
// message of both calls):
//   [slow] -> the ANSWER response is delayed (interruptibly) so a cancel can land
//   [fail] -> the ANSWER request returns HTTP 500 every time, so the job attempt
//             fails on each try -> exercises retry/backoff then permanent failure
// Routing always succeeds; only the answer call is slowed/failed, so we exercise
// the full route->retrieve->answer plumbing before the failure/slow point.

import { createServer } from "node:http";

const PORT = Number.parseInt(process.env.FIXTURE_PORT ?? "8800", 10);
const SLOW_DELAY_MS = Number.parseInt(process.env.FIXTURE_SLOW_DELAY_MS ?? "20000", 10);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

// Wraps content as a minimal OpenAI chat-completion response the provider parses
// (it only reads choices[0].message.content).
function completion(content) {
  return {
    id: "fixture-cmpl",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "fixture",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }]
  };
}

function systemText(messages) {
  const sys = messages.find((m) => m && m.role === "system");
  return typeof sys?.content === "string" ? sys.content : "";
}

function userText(messages) {
  const user = messages.find((m) => m && m.role === "user");
  return typeof user?.content === "string" ? user.content : "";
}

// A routing request's system prompt asks to "route a user question to exactly one
// knowledge flow". An answer request's system prompt opens with "Answer using only
// the provided Markdown knowledge base context".
function isRoutingCall(system) {
  return /route a user question/i.test(system);
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return sendJson(res, 200, { ok: true });
    }
    if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
      return sendJson(res, 404, { error: "not_found", url: req.url });
    }

    const raw = await readBody(req);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return sendJson(res, 400, { error: "invalid_json" });
    }
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
    const system = systemText(messages);
    const user = userText(messages);

    if (isRoutingCall(system)) {
      // Pick the first flow id offered in the user message, else fall back to a
      // deterministic id. Routing returning an unknown id would make the watcher
      // run unscoped, which is still valid; picking a real id keeps it scoped.
      const flowId = firstFlowId(user) ?? "docs";
      console.log(`[fixture] routing call -> flowId=${flowId}`);
      return sendJson(res, 200, completion(JSON.stringify({ flowId, confidence: "high", rationale: "fixture" })));
    }

    // Otherwise it's the ANSWER call.
    if (/\[fail\]/i.test(user)) {
      console.log("[fixture] answer call [fail] -> HTTP 500");
      return sendJson(res, 500, { error: "fixture_forced_failure" });
    }

    if (/\[slow\]/i.test(user)) {
      console.log(`[fixture] answer call [slow] -> delaying ${SLOW_DELAY_MS}ms`);
      let aborted = false;
      req.on("aborted", () => { aborted = true; });
      res.on("close", () => { aborted = true; });
      const start = Date.now();
      // Interruptible sleep so a client cancel/abort short-circuits the delay.
      while (Date.now() - start < SLOW_DELAY_MS && !aborted) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (aborted) {
        console.log("[fixture] slow answer aborted by client");
        return; // socket already closed
      }
    }

    const answer = {
      answer: "The configured documentation contains the requested information (fixture answer).",
      confidence: "high",
      isKnowledgeGap: false,
      gaps: []
    };
    console.log("[fixture] answer call -> answer payload");
    return sendJson(res, 200, completion(JSON.stringify(answer)));
  } catch (error) {
    console.error("[fixture] handler error:", error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "fixture_internal" });
    }
  }
});

// Extracts the first `"id": "..."` from the routing user message (the flows are
// serialized as JSON in it).
function firstFlowId(user) {
  const match = user.match(/"id"\s*:\s*"([^"]+)"/);
  return match ? match[1] : undefined;
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[fixture] OpenAI-compatible chat fixture listening on :${PORT} (slow delay ${SLOW_DELAY_MS}ms)`);
});
