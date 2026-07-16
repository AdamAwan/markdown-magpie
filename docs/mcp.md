# MCP Server

`@magpie/mcp` (`apps/mcp`) is a thin [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI agents and MCP-aware clients ask questions against the indexed Markdown knowledge base. It is a client surface over the HTTP API — it holds no state of its own and proxies every request to the API at `API_BASE_URL`.

## Transports

The server supports two standard MCP transports:

### stdio (local subprocess)

Uses the MCP **stdio transport**: each JSON-RPC message is a single line of UTF-8 JSON terminated by a newline, with no embedded newlines (per the [MCP transports spec](https://modelcontextprotocol.io/docs/concepts/transports)). The client launches the server as a subprocess and exchanges messages over stdin/stdout. Logging goes to stderr.

### Streamable HTTP (network)

Uses the MCP **Streamable HTTP transport** (spec version 2025-03-26+). Runs as a long-lived HTTP server on a configurable port. Clients send JSON-RPC requests via HTTP POST and receive responses via JSON or Server-Sent Events (SSE). This transport is built on the official `@modelcontextprotocol/server` SDK and supports both stateful and stateless modes.

## Tools

### `kb_ask`

Input: `{ "question": string, "flow"?: string, "conversationId"?: string }`

- `flow` (optional) pins the question to a flow id from `kb_flows`; defaults to `"auto"` (router decides).
- `conversationId` (optional, #239) asks a **follow-up** in a multi-turn conversation. Pass the
  `conversationId` returned by the previous `kb_ask`: the answer then resolves against the recent
  turns (pronouns/ellipsis) and stays in the same flow. Omit to start a new conversation.

Returns the final answer only:

```json
{
  "answer": "string",
  "confidence": "high | medium | low",
  "citations": [ { "documentId": "...", "sectionId": "...", "path": "...", "heading": "...", "anchor": "...", "excerpt": "..." } ],
  "gaps": [ { ... } ],   // present only when the answer exposes knowledge gaps; one entry per missing topic
  "questionId": "string", // identifier for reporting feedback via kb_feedback
  "conversationId": "string" // pass back to kb_ask to thread a follow-up onto this exchange
}
```

Answers are always produced asynchronously by a durable job:

1. `POST /api/ask` records the question and enqueues an `answer_question` job, returning **202** with `{ questionId, job, links }` — no inline answer.
2. The server waits on the job via `GET /api/jobs/:id/wait`. The wait endpoint long-polls server-side and returns **200** with the terminal job, or **202** with the current projection when its wait limit expires.
3. If the wait returns a non-terminal job (state `created`, `retry`, or `active`), the server falls back to polling the detail endpoint `GET /api/jobs/:id` every `ANSWER_POLL_INTERVAL_MS` until the job reaches a terminal state or `ANSWER_TIMEOUT_MS` elapses.

Job states are `created | retry | active` (non-terminal) and `completed | cancelled | failed` (terminal). On `completed`, the terminal job `output` is the envelope `{ result, executor }`; the answer fields live in `result`. On `failed`/`cancelled`, or if the timeout is exceeded, `kb_ask` raises an error naming the job id and state (no payload data is echoed).

The client receives only the answer payload above plus the `questionId`. Internal details — job identifiers, retrieval context, provider names, and status links — are not exposed to the client.

### `kb_search`

Input: `{ "query": string, "limit"?: number }`

Returns indexed Markdown sections matching the keyword query.

### `kb_flows`

Input: `{}`

Lists the knowledge flows a question can be routed to. Returns `{ "flows": [ { "id": string, "name": string }, ... ] }`; use an id as the `flow` argument to `kb_ask` or `kb_outline`.

### `kb_feedback`

Reports feedback on a previously asked question, using the `questionId` returned by `kb_ask`.

Input:

```json
{
  "questionId": "string",
  "kind": "helpful | unhelpful | knowledge_gap",
  "gapSummary": "string"   // optional; only used when kind is "knowledge_gap"
}
```

`helpful` / `unhelpful` record answer-quality feedback. `knowledge_gap` flags the question as a knowledge gap the system missed (the optional `gapSummary` describes the missing knowledge); this is independent of helpful/unhelpful and feeds the same gap-candidate clustering as automatic detection.

### `kb_outline`

Proposes a seed plan for a flow by exploring its source repositories — **no topic needed**. It enqueues the source-grounded `outline_flow_seed` job, waits for it, then returns the **persisted plan** its completion created. It **only proposes** — nothing is drafted; the plan waits behind the review gate. Approve it with `kb_seed`, or review/edit it in the console.

Input: `{ "flow": string, "notes"?: string }` (`notes` is an optional steer for this run).

Returns `{ "planId": string, "charter"?: string, "charterProposed": boolean, "persona"?: string, "personaProposed": boolean, "items": SeedItem[], "rationale"?: string }`, where each `SeedItem` is `{ title?, targetPath?, coverage: string[], questions?: string[] }`. The `*Proposed` flags record that the charter/persona came from the model because the flow config lacked one — copy the value into `KNOWLEDGE_FLOWS` to make it permanent. On `failed`/`cancelled`, or if the timeout is exceeded, `kb_outline` raises an error naming the job id and state (no payload data is echoed).

### `kb_seed`

Approves a seed plan (from `kb_outline` or the console): drafts one document per approved item straight into the proposal → pull-request pipeline, carrying the plan's run-scoped charter/persona. Edit or partially dismiss items in the console first if needed.

Input: `{ "plan": string }` — the plan id (from `kb_outline`'s `planId`, or the console).

Returns `{ "planId": string, "jobIds": string[] }` — one enqueued `draft_seed_document` job per approved item. See [ai-jobs.md](ai-jobs.md#seeding-a-flow) for the full seeding flow.

### `kb_citation`

Fetches the full content of cited sections so end users can see the evidence behind an answer.

Input: `{ "sectionIds": string[] }` — 1–20 `sectionId` values from `kb_ask` citations (or `kb_search` results).

Returns `{ "sections": [ DocumentSection, ... ], "missing": string[] }`. Each section is the **currently indexed** version (the KB may have changed since the answer was produced). Ids that no longer resolve land in `missing` instead of failing the call — the knowledge base changed; re-ask or use `kb_search`.

### `kb_questionnaire_create`

Creates a [questionnaire](questionnaires.md) — a named batch of questions answered against one flow's knowledge base, with verbatim reuse of previously approved answers while the KB sections they cited are unchanged.

Input: `{ "name": string, "flow": string, "questions": string[] }` — 1–500 questions, one per entry; `flow` ids come from `kb_flows`.

Returns the initial worksheet immediately (same shape as `kb_questionnaire_get`). **Creation is asynchronous by design**: reused items already carry answers, but fresh/changed items drip through the `answer_question` queue — a batch can be hundreds of questions, so the tool never waits. Re-read with `kb_questionnaire_get` until no items are `pending`/`answering`.

### `kb_questionnaire_get`

Reads a questionnaire worksheet. Input: `{ "questionnaire": string }` (the id from `kb_questionnaire_create`).

Returns:

```json
{
  "id": "string",
  "name": "string",
  "flowId": "string",
  "status": "open | completed | archived",
  "items": [
    {
      "id": "string",                       // pass to kb_questionnaire_approve's `item`
      "position": 0,
      "question": "string",
      "status": "pending | answering | answered | unanswerable | approved",
      "outcome": "reused | fresh | changed", // present once matched/answered
      "answer": "string",                    // present once answered
      "changeReason": { "kind": "section_changed | section_missing | new_content", "...": "..." },
      "citations": [ { "path": "...", "heading": "..." } ]
    }
  ]
}
```

Internal plumbing (question-log ids, reuse links, citation content fingerprints) is stripped — the worksheet carries what a reviewing model needs. Reading the worksheet also resumes a stalled answer drip server-side.

### `kb_questionnaire_approve`

Approves answers into the match corpus for future questionnaires — the human/agent act that makes an answer reusable verbatim next time.

Input: `{ "questionnaire": string, "item"?: string }`.

Without `item`, bulk-approves all reused items (`POST /api/questionnaires/:id/approve-reused`) and returns `{ "approved": number }`. With `item`, approves that single answered item (`POST /api/questionnaires/:id/items/:itemId/approve`) and returns `{ "ok": true }`; the API answers 409 unless the item's status is `answered`.

## Configuration

### Common (all transports)

| Variable | Default | Purpose |
| --- | --- | --- |
| `API_BASE_URL` | `http://localhost:4000` | Base URL of the Markdown Magpie API. |
| `ANSWER_POLL_INTERVAL_MS` | `1000` | How often `kb_ask` polls the answer job's detail endpoint after a non-terminal wait. |
| `ANSWER_TIMEOUT_MS` | `120000` | How long `kb_ask` waits for a queued answer before failing. |
| `OUTLINE_POLL_INTERVAL_MS` | `1500` | How often `kb_outline` polls the outline job's detail endpoint after a non-terminal wait. |
| `OUTLINE_TIMEOUT_MS` | `180000` | How long `kb_outline` waits for a queued outline before failing. |

### Streamable HTTP only

| Variable | Default | Purpose |
| --- | --- | --- |
| `MCP_HTTP_PORT` | `4001` | Port the HTTP server listens on. |
| `MCP_HTTP_HOST` | `127.0.0.1` | Host interface to bind to (set `0.0.0.0` to expose on all interfaces). |
| `MCP_RESOURCE_URL` | `http://localhost:<port>/mcp` | Public URL of the `/mcp` endpoint, advertised in the OAuth protected-resource metadata. |
| `MCP_API_AUTH_TOKEN` | — | Service token used for downstream API calls. Required when `AUTH_REQUIRED=true` (the server fails fast at startup otherwise). |

### Auth variables (both transports)

Auth **fails closed** and is shared with the API via the `@magpie/auth` package: it is required unless `AUTH_REQUIRED=false` is set explicitly. These variables must be configured whenever auth is enabled (i.e. unless you have opted out); the [Authentication](#authentication) section below explains how they are used.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AUTH_REQUIRED` | `true` (fails closed) | Set `false` to explicitly disable Auth0 bearer-token validation. Any other/unset value keeps auth required. |
| `AUTH0_ISSUER_BASE_URL` | — | Full Auth0 issuer (e.g. `https://your-tenant.eu.auth0.com`). |
| `AUTH0_DOMAIN` | — | Alternative to the issuer base; the issuer becomes `https://<domain>/`. |
| `AUTH0_AUDIENCE` | `https://markdown-magpie.local/api` | API identifier the token must carry. |
| `AUTH0_JWKS_URI` | `https://<domain>/.well-known/jwks.json` | Optional JWKS endpoint override (derived from the trailing-slash-normalised issuer when unset). |
| `MCP_AUTH_TOKEN` | — | stdio only: bearer token presented to the API. Required unless `AUTH_REQUIRED=false` (the stdio server fails fast at startup otherwise). |

## Authentication

Authentication **fails closed**: both transports require Auth0-issued tokens unless an operator explicitly sets `AUTH_REQUIRED=false`. Only when explicitly disabled do the transports run unauthenticated for local development. When enabled, tokens are validated locally against the Auth0 JWKS — see the [Auth0 design](superpowers/specs/2026-06-18-auth0-mcp-gating-design.md) for the full model.

### Streamable HTTP

The HTTP transport acts as an OAuth protected resource:

- It serves protected-resource metadata at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` (advertising the resource URL from `MCP_RESOURCE_URL`, the Auth0 authorization server, and the supported scopes).
- Every request to `/mcp` requires `Authorization: Bearer <token>` when `AUTH_REQUIRED=true`. A missing or invalid token returns `401` with a `WWW-Authenticate: Bearer resource_metadata="..."` header pointing at the metadata document.
- `tools/call` additionally enforces a per-tool scope; insufficient scope returns `403`. Other methods (`initialize`, `tools/list`, `ping`, ...) need only a valid token.
- JSON-RPC **batch** (array) bodies are enforced too: the required scope is the **union** across every batched `tools/call`, and a token missing any one of them is rejected with `403` before the batch is dispatched. This closes a bypass where an array body has no top-level `method` and would otherwise skip per-tool scope checks.

Per-tool scopes:

| Tool | Required scope |
| --- | --- |
| `kb_search` | `read:knowledge` |
| `kb_flows` | `read:knowledge` |
| `kb_ask` | `ask:knowledge` |
| `kb_feedback` | `feedback:questions` |
| `kb_outline` | `manage:jobs` |
| `kb_seed` | `manage:jobs` |
| `kb_citation` | `read:knowledge` |
| `kb_questionnaire_create` | `ask:knowledge` |
| `kb_questionnaire_get` | `read:knowledge` |
| `kb_questionnaire_approve` | `manage:knowledge` |

The inbound user token is validated locally and **never forwarded** to the API. The HTTP server calls the API with its own separate service token, `MCP_API_AUTH_TOKEN` (a machine-to-machine credential). Startup fails fast if `AUTH_REQUIRED=true` and this token is missing.

**On-behalf-of delegation.** So the API's per-flow authorization can apply to the real user (not the shared service identity), the HTTP server forwards the verified user's `subject` and `roles` as `x-on-behalf-of-*` headers alongside the service token. The API honors them only when the MCP's M2M application holds the `act:on-behalf-of` permission — grant it on the API in Auth0 to activate per-user enforcement on the MCP surface. See [authorization.md](authorization.md#mcp-acting-as-the-end-user-on-behalf-of-delegation).

### stdio

The stdio transport presents a single bearer token to the API on every call, supplied via `MCP_AUTH_TOKEN`. When `AUTH_REQUIRED=true` and the token is missing, the server fails fast at startup with a non-zero exit.

## Requirements

- The API must be running and reachable at `API_BASE_URL`.
- A watcher must be running to process AI jobs; otherwise `kb_ask` (`answer_question`) and `kb_outline` (`outline_flow_seed`) will time out, `kb_seed`'s (`draft_seed_document`) jobs stay queued, and `kb_questionnaire_create`'s fresh/changed items stay `pending`/`answering` forever.

## Running

### stdio (local)

```bash
npm run build            # produces apps/mcp/dist/main.js
API_BASE_URL=http://localhost:4000 node apps/mcp/dist/main.js
```

Under Docker Compose, the server is available via the `mcp` profile:

```bash
docker compose --profile mcp run --rm mcp
```

### Streamable HTTP (network)

```bash
npm run build            # produces apps/mcp/dist/http.js
API_BASE_URL=http://localhost:4000 npm run start:http -w @magpie/mcp
```

Under Docker Compose, the HTTP server is available via the `mcp-http` profile:

```bash
docker compose --profile mcp-http up -d mcp-http
```

The server listens on port 4001 by default. The MCP endpoint is at `http://localhost:4001/mcp` and a health check is at `http://localhost:4001/health`.

## Connecting Clients

### Claude Code (stdio)

A project-scoped `.mcp.json` at the repository root registers the server with Claude Code:

```json
{
  "mcpServers": {
    "markdown-magpie": {
      "command": "node",
      "args": ["apps/mcp/dist/main.js"],
      "env": { "API_BASE_URL": "http://localhost:4000" }
    }
  }
}
```

Build first (`npm run build`) so `apps/mcp/dist/main.js` exists, ensure the API and a watcher are running, then start Claude Code from the repository root and approve the server when prompted.

### Hermes Agent (Streamable HTTP)

Add to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  markdown-magpie:
    url: "http://localhost:4001/mcp"
    timeout: 180
```

Restart Hermes Agent. Tools will appear as `mcp_markdown-magpie_kb_ask`, `mcp_markdown-magpie_kb_search`, and `mcp_markdown-magpie_kb_feedback`.

### Any MCP Client (Streamable HTTP)

Point the client at `http://<host>:4001/mcp`. The server implements the MCP Streamable HTTP transport and is compatible with any spec-compliant client (Claude Desktop, VS Code, Continue, etc.).
