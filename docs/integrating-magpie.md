# Integrating Magpie into another application

> **Status:** integration guide (how-to). This is the entry point for developers **consuming**
> a running Markdown Magpie instance from their own application — for example, giving a
> chatbot access to a curated Markdown knowledge base. It is task-oriented rather than an
> as-built subsystem spec, but the normative clauses carry stable IDs (`I1`, `I2`, …) so tests
> and PRs can cite them. For the full reference surfaces it links to, see [mcp.md](./mcp.md),
> [api.md](./api.md), [retrieval.md](./retrieval.md), [authorization.md](./authorization.md),
> and [rate-limiting.md](./rate-limiting.md).

## What you are integrating with

Magpie is the **knowledge layer**, not the chatbot. Your application owns the conversation,
the UI, and (if you want) its own LLM. It reaches into Magpie to turn a user's question into
either a **cited answer** or a set of **relevant source sections**, drawn only from the
curated Markdown knowledge base you have configured as flows.

```text
                              Magpie
                    ┌──────────────────────────┐
Your app  ──ask──▶  │  MCP server  │  HTTP API  │ ──▶  cited answer
(chatbot) ──search─▶│  (kb_* tools)│  (/api/*)  │ ──▶  source sections
                    └──────────────────────────┘
                          │ enqueue + wait
                          ▼
                    watcher → LLM provider (queue-only)
```

- **I1** — Magpie exposes knowledge over **two surfaces**: the **MCP server**
  ([mcp.md](./mcp.md)) for MCP-aware agents, and the **HTTP API** ([api.md](./api.md)) for any
  language or runtime. The MCP server is a thin client over the same HTTP API, so the two are
  behaviourally identical — pick the one that fits your stack, not your use case.
- **I2** — Generative answering is **asynchronous and queue-only**: an ask enqueues a job that
  a separate watcher process runs against the configured LLM provider. Your integration never
  gets a streamed token feed; it waits for a completed answer. The MCP `kb_ask` tool hides this
  wait behind a single blocking call; the raw HTTP path exposes it as a `202` + long-poll (see
  [The answer pattern over HTTP](#the-answer-pattern-over-http)).

## Step 1 — Pick a pattern

There are two ways to use Magpie as a chatbot's knowledge source. They are not exclusive — many
integrations use the answer pattern for direct questions and the retrieval pattern for grounding
freeform generation.

### Answer pattern — let Magpie answer

Your app hands Magpie a question; Magpie runs its agentic retrieval loop (route → retrieve →
bounded follow-up searches → answer) and returns a **grounded answer with citations,
confidence, and detected knowledge gaps**. You render the answer.

- Tool / endpoint: **`kb_ask`** / **`POST /api/ask`**.
- Use when: you want a finished, cited answer and are happy for Magpie to own retrieval *and*
  generation. This is the shortest path to "my chatbot answers from the docs".

### Retrieval pattern — bring your own LLM

Your app already has an LLM (or a larger agent) and wants Magpie only as the **knowledge base**.
You search for relevant sections, pull their full text, and inject them into your own prompt as
RAG context.

- Tools / endpoints: **`kb_search`** + **`kb_citation`** / **`GET /api/knowledge/search`** +
  **`GET /api/knowledge/sections/:id`**.
- Use when: you need control over the final generation (your own model, prompt, persona,
  formatting), or you are composing Magpie knowledge with other tools in one agent turn.

### Which to pick

| | Answer pattern | Retrieval pattern |
| --- | --- | --- |
| Who runs the LLM | Magpie (queue-only) | Your app |
| You get back | Cited answer + confidence + gaps | Ranked source sections (raw Markdown) |
| Latency shape | Async (enqueue → wait) | Synchronous (plain reads) |
| Citations | Provided | You build them from the sections you used |
| Cost centre | Magpie's provider budget & [rate limits](./rate-limiting.md) | Your own LLM; Magpie search is cheap |
| Best for | "Answer from the docs" chatbots | Agents/chatbots with their own model |

- **I3** — The retrieval pattern MUST NOT be treated as a way to bypass answering: search and
  citation return **indexed source Markdown**, not answers. Grounding, refusal, and citation of
  *only what was used* are the answer pattern's job. If your app injects retrieved sections into
  its own model, the quality and safety of the final answer are your app's responsibility.

## Step 2 — Pick a surface

### MCP (drop-in for MCP-aware agents)

If your chatbot is built on an MCP-capable framework (Claude Code/Desktop, an agent runtime,
etc.), register Magpie's MCP server and the `kb_*` tools appear automatically. Two transports
are available — **stdio** (subprocess) and **Streamable HTTP** (network). Full wiring, per-tool
scopes, and client examples are in [mcp.md](./mcp.md#connecting-clients); the short version for
Streamable HTTP:

```jsonc
// point any MCP client at the running HTTP MCP server
{ "url": "http://<host>:4001/mcp" }
```

Relevant tools: `kb_ask` (answer pattern), `kb_search` + `kb_citation` (retrieval pattern),
`kb_flows` (list routable flows). `kb_ask` blocks until the queued answer is ready and returns
the final payload — you do **not** implement the wait yourself.

### Raw HTTP (any language or runtime)

For everything else, call the API directly. The endpoints below are the consumer subset of
[api.md](./api.md); the answer path is asynchronous, the retrieval path is plain reads.

- **I4** — A raw-HTTP integration of the answer pattern MUST honour the async contract: `POST
  /api/ask` returns **202** with a `links.wait` URL, and the caller blocks on that long-poll
  until the job is terminal before reading the answer. Treating the `202` body as the answer is
  a bug — at `202` no answer exists yet.

## Step 3 — Worked example: give a chatbot Magpie knowledge

The running example: a support chatbot answers a user's *"How do I roll back a hotfix?"* from a
`docs` flow.

### The answer pattern over MCP

Your chatbot calls one tool and renders the result:

```jsonc
// tool call
kb_ask({ "question": "How do I roll back a hotfix?", "flow": "docs" })

// result (the queued answer, already waited on for you)
{
  "answer": "To roll back a hotfix, revert the merge commit on the release branch and …",
  "confidence": "high",
  "citations": [
    { "path": "runbooks/hotfix.md", "heading": "Rolling back", "anchor": "rolling-back",
      "sectionId": "…", "documentId": "…", "excerpt": "Revert the merge commit …" }
  ],
  "gaps": [],
  "questionId": "…",        // pass to kb_feedback to report answer quality / a missed gap
  "conversationId": "…"     // pass back to kb_ask to thread a follow-up
}
```

- `flow` is optional. Omit it (or pass `"auto"`) to let Magpie route the question. List the
  routable flows with `kb_flows` to populate a picker or to pin a flow explicitly.
- Render `citations` as source links so users can verify the answer; surface `confidence` as a
  badge, not a suppressor.
- For a follow-up ("*what about a database migration in that hotfix?*"), call `kb_ask` again
  with the returned `conversationId` — Magpie resolves pronouns/ellipsis and keeps the flow.

### The answer pattern over HTTP

The same exchange without MCP. Three calls: enqueue, wait, read.

```bash
# 1. Enqueue — returns 202 with links (no answer yet)
curl -sS -X POST http://<host>:4000/api/ask \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "question": "How do I roll back a hotfix?", "flow": "docs" }'
# → 202 { "questionId": "…", "conversationId": "…", "job": {…},
#         "links": { "question": "/api/questions/…", "wait": "/api/jobs/…/wait", … } }

# 2. Wait — long-poll links.wait until it returns 200 (terminal). A 202 means "still
#    running, ask again". Re-issue until 200.
curl -sS http://<host>:4000/api/jobs/<jobId>/wait -H "Authorization: Bearer $TOKEN"

# 3. Read the answer — GET links.question; the answer lives on question.answer
curl -sS http://<host>:4000/api/questions/<questionId> -H "Authorization: Bearer $TOKEN"
# → 200 { "question": { …, "answer": { "answer": "…", "confidence": "high",
#         "citations": [ … ], "gaps": [ … ] } } }
```

A minimal TypeScript helper that captures the whole loop:

```ts
async function askMagpie(question: string, flow = "auto") {
  const base = "http://<host>:4000";
  const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

  // 1. enqueue
  const enq = await fetch(`${base}/api/ask`, {
    method: "POST", headers, body: JSON.stringify({ question, flow }),
  });
  const { questionId, links } = await enq.json();

  // 2. wait — the endpoint 202s while running and 200s when terminal
  while ((await fetch(`${base}${links.wait}`, { headers })).status === 202) { /* re-poll */ }

  // 3. read the completed answer
  const res = await fetch(`${base}${links.question}`, { headers });
  return (await res.json()).question.answer; // { answer, confidence, citations, gaps }
}
```

### The retrieval pattern (bring your own LLM)

Search for relevant sections, expand the ones you want to their full text, and inject them into
your own prompt.

```bash
# 1. Search — ranked indexed sections (best match first)
curl -sS "http://<host>:4000/api/knowledge/search?q=roll+back+a+hotfix&limit=5" \
  -H "Authorization: Bearer $TOKEN"
# → 200 { "sections": [ { "id": "…", "path": "runbooks/hotfix.md",
#         "heading": "Rolling back", "headingPath": ["Hotfixes","Rolling back"],
#         "anchor": "rolling-back", "content": "Revert the merge commit …", "ordinal": 3 }, … ] }

# 2. (optional) Expand a specific section to its full current text
curl -sS http://<host>:4000/api/knowledge/sections/<sectionId> \
  -H "Authorization: Bearer $TOKEN"
# → 200 { "section": { … full DocumentSection … } }
```

Over MCP the same two steps are `kb_search({ query, limit })` and
`kb_citation({ sectionIds })`. Concatenate the `content` of the sections you chose into your
model's context, and build your own citations from each section's `path`/`heading`/`anchor`.

### Handling the edges

- **I5** — Integrations MUST handle these non-answer outcomes rather than treating every ask as
  a plain answer:
  - **`flowSelectionRequired`** — `"auto"` routing could not decide. The result carries the
    available flows (also from `kb_flows` / `GET /api/knowledge/flows`); re-ask with `flow` set
    to one of them. Confidence is `"unknown"` and no answer text is present.
  - **`outOfScope`** — the picked flow judged the question off-topic for its knowledge area and
    declined. This is *not* a knowledge gap; do not treat it as a low-confidence answer.
  - **`gaps`** (non-empty) — Magpie answered but flagged missing knowledge. Optionally report a
    `knowledge_gap` via `kb_feedback` / the feedback route to feed Magpie's gap clustering.
  - **Empty `citations`** — nothing in the KB met the relevance floor. Surface "not covered",
    don't invent an answer.

## Step 4 — Authenticate

- **I6** — Auth **fails closed**: it is required unless an operator explicitly sets
  `AUTH_REQUIRED=false` (a local-development shortcut only — never rely on it for a real
  integration). See [authorization.md](./authorization.md).
- **I7** — A backend integration authenticates to the **HTTP API** with its own **machine-to-
  machine (M2M) credential**, obtained via the OAuth **client-credentials** grant against your
  Auth0 tenant for the API audience (`AUTH0_AUDIENCE`). Acquire the token at runtime and cache
  it until shortly before expiry — Auth0 access tokens expire (default ~24h), so a pasted static
  token silently breaks a day after deploy (`packages/auth/src/api-token.ts`, AZ21). Present it
  as `Authorization: Bearer <token>` on every call.
- **I8** — The token MUST carry the **scope** each call requires — `read:knowledge` for
  `kb_search`/`kb_citation`/`kb_flows` and the knowledge reads, `ask:knowledge` for
  `kb_ask`/`POST /api/ask`. Insufficient scope is a `403`. The full per-tool/route scope tables
  are in [mcp.md](./mcp.md#authentication--authorization) and [api.md](./api.md).
- **I9** — When integrating over the **Streamable HTTP MCP** transport instead of the API
  directly, that server is an **OAuth protected resource**: it advertises metadata at
  `/.well-known/oauth-protected-resource`, validates the end user's token at its edge, and calls
  the API with its *own* service credential. If you want per-user flow access enforced through
  the MCP surface, use the on-behalf-of delegation described in
  [mcp.md](./mcp.md#authentication--authorization) / [authorization.md](./authorization.md).

## Operational notes

- **I10** — The **API and a watcher must both be running**. `kb_ask` / `POST /api/ask` enqueue a
  job the watcher runs; with no watcher advertising the answering capability, the answer pattern
  **times out**. The retrieval pattern (search/citation) needs only the API. See
  [mcp.md](./mcp.md#requirements).
- **I11** — Metered work is **rate-limited and cost-capped**: per-principal request tiers plus a
  global cap on concurrent in-flight AI jobs. Expect `429` with `RateLimit-*` headers under load
  and back off accordingly; the answer pattern is the metered one, search is cheap. See
  [rate-limiting.md](./rate-limiting.md).
- **Timeouts.** Over MCP, `kb_ask` bounds its own wait (`ANSWER_TIMEOUT_MS`, default 120s) and
  raises if the job does not finish. Over HTTP, size your poll loop on `links.wait` similarly.

## Out of scope for this guide

- **Streaming** — Magpie does not stream answer tokens; the model is enqueue-then-complete.
- **Authoring / seeding the KB** — `kb_outline`/`kb_seed` and the proposal → pull-request
  pipeline are about *building* knowledge, not consuming it. See
  [flows-and-seeding.md](./flows-and-seeding.md) and
  [proposals-and-publishing.md](./proposals-and-publishing.md).
- **Questionnaires** — batched offline answering (`kb_questionnaire_*`) is a distinct workflow;
  see [questionnaires.md](./questionnaires.md).

## Reference map

This guide adds no code of its own; it composes existing surfaces. Follow these for the
authoritative contracts:

| Concern | Reference |
| --- | --- |
| `kb_*` tools, transports, per-tool scopes, client wiring | [mcp.md](./mcp.md) |
| HTTP endpoints (`/api/ask`, `/api/knowledge/*`, `/api/jobs/:id/wait`, `/api/questions/:id`) | [api.md](./api.md) |
| The agentic answer loop, routing, relevance floor, citations | [retrieval.md](./retrieval.md) |
| Auth model, scopes, M2M client-credentials, on-behalf-of delegation | [authorization.md](./authorization.md) |
| Rate limits, AI cost caps, `RateLimit-*`/`429` behaviour | [rate-limiting.md](./rate-limiting.md) |
| Response types (`AnswerResult`, `Citation`, `DocumentSection`, `QuestionLog`) | `packages/core/src/index.ts` |

## Provenance (design history)

Consolidates the consumer-facing behaviour of the surfaces above; the design history for those
surfaces lives with their own specs (see each linked spec's *Provenance* section).
