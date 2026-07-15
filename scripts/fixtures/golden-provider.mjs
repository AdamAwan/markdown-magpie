#!/usr/bin/env node
// Deterministic OpenAI-compatible provider for the golden-question eval
// (scripts/eval-golden.ts). TEST-ONLY — selected explicitly via
// OPENAI_COMPATIBLE_BASE_URL, never a product provider.
//
// Unlike the queue-lifecycle fixture (openai-fixture.mjs), this one speaks the
// full answer_question protocol so the eval genuinely exercises the pipeline:
//
//   - ROUTING calls (system prompt "route a user question…") pick a flow by
//     question/persona keyword overlap, abstaining honestly on zero overlap.
//   - ASSESS calls (the answer-question instructions) parse the retrieved
//     context, request follow-up searches for uncovered clauses, and compose
//     answers ONLY from sentences of the sections that cover the question —
//     so retrieval regressions directly change citations and confidence.
//   - VERIFY calls (the verify-answer instructions) check every answer
//     sentence appears in the cited context and strip anything fabricated.
//
// All decisions are pure functions of the request text (scripts/lib/
// golden-core.mjs), so a run over the same KB and question set is exactly
// reproducible.

import { createServer } from "node:http";
import { assessCall, routeCall, verifyCall } from "../lib/golden-core.mjs";

const PORT = Number.parseInt(process.env.FIXTURE_PORT ?? "8801", 10);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

// Minimal OpenAI chat-completion envelope; the provider only reads
// choices[0].message.content.
function completion(content) {
  return {
    id: "golden-cmpl",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "golden-fixture",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }]
  };
}

function messageText(messages, role) {
  const match = messages.find((m) => m && m.role === role);
  return typeof match?.content === "string" ? match.content : "";
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return sendJson(res, 200, { ok: true });
    }
    if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
      return sendJson(res, 404, { error: "not_found", url: req.url });
    }

    let parsed;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: "invalid_json" });
    }
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
    const system = messageText(messages, "system");
    const user = messageText(messages, "user");

    if (/route a user question/i.test(system)) {
      const reply = routeCall(user);
      console.log(`[golden] routing -> ${reply.flowId ?? "abstain"}`);
      return sendJson(res, 200, completion(JSON.stringify(reply)));
    }
    if (/You verify a drafted knowledge-base answer/i.test(system)) {
      const reply = verifyCall(user);
      console.log(`[golden] verify -> grounded=${reply.grounded}`);
      return sendJson(res, 200, completion(JSON.stringify(reply)));
    }
    if (/You answer a question using only the provided Markdown/i.test(system)) {
      const reply = assessCall(system, user);
      console.log(
        reply.action === "search"
          ? `[golden] assess -> search ${JSON.stringify(reply.queries)}`
          : `[golden] assess -> answer (confidence=${reply.confidence})`
      );
      return sendJson(res, 200, completion(JSON.stringify(reply)));
    }

    // Any other call means the pipeline changed shape under the eval — fail
    // the provider call loudly rather than returning plausible nonsense.
    console.error(`[golden] unrecognised system prompt: ${system.slice(0, 120)}`);
    return sendJson(res, 500, { error: "golden_fixture_unrecognised_call" });
  } catch (error) {
    console.error("[golden] handler error:", error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "golden_fixture_internal" });
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[golden] deterministic golden provider listening on :${PORT}`);
});
