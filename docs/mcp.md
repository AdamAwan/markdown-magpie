# MCP Server

> **Status:** living spec (as-built). Source of truth for the `@magpie/mcp` server —
> the two MCP transports it speaks, its posture as a thin client over the HTTP API, how
> auth gates each call, and the contract of every exposed `kb_*` tool. Follows the
> [spec conventions](./README.md#conventions).

## Purpose

Let AI agents and MCP-aware clients reach the indexed Markdown knowledge base — ask cited
questions, search sections, propose/approve seed plans, run questionnaires, and report
feedback — over the [Model Context Protocol](https://modelcontextprotocol.io). The server
(`apps/mcp`) is a **client surface over the HTTP API**: it holds no knowledge state, runs
no generative or embedding work of its own, and proxies every request to the API at
`API_BASE_URL`. All generative answering therefore stays queue-only
([ai-jobs.md](./ai-jobs.md)); the MCP server only enqueues via the API and waits.

## Architecture & execution model

- **M1** — The MCP server MUST hold no knowledge state and MUST NOT talk to the database
  or call a model provider. Every tool call proxies to the HTTP API at `API_BASE_URL`; the
  server is a stateless client surface, so all behaviour it exposes is the API's behaviour
  re-shaped for MCP clients.
- **M2** — `kb_ask` MUST be asynchronous end-to-end (never an inline answer): the server
  `POST`s `/api/ask`, which records the question and enqueues an `answer_question` job and
  returns **202** with `{questionId, job, links}`. The server then waits on the job via
  `GET /api/jobs/:id/wait` — a server-side long-poll that returns **200** with the terminal
  job or **202** with the current projection when its wait limit expires — and falls back
  to polling `GET /api/jobs/:id` every `ANSWER_POLL_INTERVAL_MS` while the job is
  non-terminal (`created | retry | active`) until it terminates or `ANSWER_TIMEOUT_MS`
  elapses.
- **M3** — On `completed`, the terminal job `output` is the envelope `{result, executor}`
  and the answer fields live in `result`; the server returns only the answer payload
  (below) plus `questionId`/`conversationId`. Terminal states are
  `completed | cancelled | failed`. On `failed`/`cancelled` or timeout, `kb_ask` MUST raise
  an error naming the job id and state and MUST NOT echo payload data. Internal details —
  job identifiers, retrieval context, provider names, status links — are never surfaced to
  the client.
- **M4** — `kb_outline` follows the same enqueue-then-wait shape against the source-grounded
  `outline_flow_seed` job, polling `OUTLINE_POLL_INTERVAL_MS` up to `OUTLINE_TIMEOUT_MS`,
  and returns the **persisted plan** the completion created. On `failed`/`cancelled`/timeout
  it raises an error naming the job id and state with no payload echoed.

## Transports

- **M5** — The server MUST offer two standard MCP transports from the same tool set: the
  **stdio transport** (`apps/mcp/dist/main.js`, launched as a subprocess) and the
  **Streamable HTTP transport** (`apps/mcp/dist/http.js`, a long-lived network server).
- **M6** — **stdio framing.** Each JSON-RPC message is a single line of UTF-8 JSON
  terminated by a newline, with no embedded newlines (per the
  [MCP transports spec](https://modelcontextprotocol.io/docs/concepts/transports)). The
  client exchanges messages over stdin/stdout; all logging goes to **stderr** so it never
  corrupts the framed channel.
- **M7** — **Streamable HTTP** (spec version 2025-03-26+) runs on a configurable port.
  Clients send JSON-RPC requests via HTTP `POST` to `/mcp` and receive JSON or
  Server-Sent Events (SSE). It is built on the official `@modelcontextprotocol/server` SDK
  and supports both stateful and stateless modes. A health check is served at `/health`.

## Authentication & authorization

- **M8** — Auth **fails closed** and is shared with the API via the `@magpie/auth` package:
  it is required unless an operator explicitly sets `AUTH_REQUIRED=false`. Any other or
  unset value keeps auth required. When enabled, Auth0-issued tokens are validated locally
  against the Auth0 JWKS — see the [Auth0 design](superpowers/specs/2026-06-18-auth0-mcp-gating-design.md).
- **M9** — **stdio auth.** The stdio transport presents a single bearer token
  (`MCP_AUTH_TOKEN`) to the API on every call. When `AUTH_REQUIRED=true` and the token is
  missing, the server MUST fail fast at startup with a non-zero exit
  (`resolveStdioAuthToken`).
- **M10** — **HTTP transport is an OAuth protected resource.** It serves protected-resource
  metadata at `/.well-known/oauth-protected-resource` and
  `/.well-known/oauth-protected-resource/mcp` (advertising the resource URL from
  `MCP_RESOURCE_URL`, the Auth0 authorization server, and the supported scopes). Every
  request to `/mcp` requires `Authorization: Bearer <token>` when `AUTH_REQUIRED=true`; a
  missing or invalid token returns **401** with a
  `WWW-Authenticate: Bearer resource_metadata="..."` header pointing at the metadata
  document. Methods other than `tools/call` (`initialize`, `tools/list`, `ping`, …) need
  only a valid token.
- **M11** — **Per-tool scope.** `tools/call` additionally enforces the required scope for
  the named tool (table below); insufficient scope returns **403**. JSON-RPC **batch**
  (array) bodies are enforced too: the required scope is the **union** across every batched
  `tools/call`, and a token missing any one of them is rejected with **403** before the
  batch is dispatched — closing a bypass where an array body has no top-level `method` and
  would otherwise skip per-tool checks.
- **M12** — **Service credential, not token passthrough.** The inbound user token is
  validated locally and MUST NOT be forwarded to the API. The HTTP server calls the API
  with its **own** service credential and fails fast at startup (when `AUTH_REQUIRED=true`)
  if none is configured.
  > ⚠️ Corrected against code: the service credential is **either** an auto-refreshing
  > client-credentials pair `MCP_API_CLIENT_ID` + `MCP_API_CLIENT_SECRET` (preferred — it
  > survives the ~24h Auth0 token lifetime) **or** a static `MCP_API_AUTH_TOKEN`. Startup
  > fails fast only when `AUTH_REQUIRED=true` **and both are absent** (`http.ts` main). The
  > earlier spec wording ("required … fails fast otherwise", naming only
  > `MCP_API_AUTH_TOKEN`) understated the client-credentials path.
- **M13** — **On-behalf-of delegation.** So the API's per-flow authorization applies to the
  real user rather than the shared service identity, the HTTP server forwards the verified
  user's `subject` and `roles` as `x-on-behalf-of-*` headers alongside the service token.
  The API honors them only when the MCP's M2M application holds the `act:on-behalf-of`
  permission — grant it on the API in Auth0 to activate per-user enforcement on the MCP
  surface. See
  [authorization.md](authorization.md#mcp-acting-as-the-end-user-on-behalf-of-delegation).

Per-tool scopes (mirrors the API route scopes; enforced at the MCP boundary in
`apps/mcp/src/http.ts`):

| Tool | Required scope |
| --- | --- |
| `kb_search` | `read:knowledge` |
| `kb_flows` | `read:knowledge` |
| `kb_citation` | `read:knowledge` |
| `kb_ask` | `ask:knowledge` |
| `kb_questionnaire_create` | `ask:knowledge` |
| `kb_questionnaire_get` | `read:knowledge` |
| `kb_feedback` | `feedback:questions` |
| `kb_outline` | `manage:jobs` |
| `kb_seed` | `manage:jobs` |
| `kb_questionnaire_approve` | `manage:knowledge` |

## Exposed tools

The server exposes exactly these ten `kb_*` tools (verified against the `tools` array and
the `callTool` dispatch in `apps/mcp/src/main.ts`). This table is the quick reference; the
non-obvious behavioural contracts are numbered below.

| Tool | Input | Proxies to | Purpose |
| --- | --- | --- | --- |
| `kb_ask` | `{question, flow?, conversationId?}` | `POST /api/ask` → job wait | Cited answer for a question (async job). |
| `kb_search` | `{query, limit?}` | `GET /knowledge/search` | Keyword-matched indexed sections. |
| `kb_flows` | `{}` | `GET /flows` | List routable flows `{id, name}`. |
| `kb_feedback` | `{questionId, kind, gapSummary?}` | feedback route | Record answer-quality / gap feedback. |
| `kb_outline` | `{flow, notes?}` | `POST /flows/:id/outline` → job wait | Propose a source-grounded seed plan. |
| `kb_seed` | `{plan}` | `POST /seed-plans/:id/approve` | Approve a plan → draft docs into the PR pipeline. |
| `kb_citation` | `{sectionIds[1..20]}` | citation route | Full text of cited sections. |
| `kb_questionnaire_create` | `{name, flow, questions[1..500]}` | questionnaire route | Create a batched-answer questionnaire. |
| `kb_questionnaire_get` | `{questionnaire}` | questionnaire route | Read a questionnaire worksheet. |
| `kb_questionnaire_approve` | `{questionnaire, item?}` | approve route(s) | Approve answers into the match corpus. |

### `kb_ask`

- **M14** — Input `{question, flow?, conversationId?}`. `flow` (optional) pins the question
  to a flow id from `kb_flows`; it defaults to `"auto"` (the router decides). If routing
  cannot determine a flow the result carries `flowSelectionRequired` with the available
  flows — the caller re-invokes with `flow` set to one of those ids.
- **M15** — `conversationId` (optional) asks a **follow-up** in a multi-turn conversation.
  Passing the `conversationId` returned by a previous `kb_ask` resolves the answer against
  the recent turns (pronouns/ellipsis) and keeps it in the same flow; omitting it starts a
  new conversation. A `conversationId` is always returned to thread from.
- **M16** — Returns the final answer only:

  ```json
  {
    "answer": "string",
    "confidence": "high | medium | low",
    "citations": [ { "documentId": "...", "sectionId": "...", "path": "...", "heading": "...", "anchor": "...", "excerpt": "..." } ],
    "gaps": [ { "...": "..." } ],   // present only when the answer exposes knowledge gaps; one entry per missing topic
    "questionId": "string",          // identifier for reporting feedback via kb_feedback
    "conversationId": "string"       // pass back to kb_ask to thread a follow-up onto this exchange
  }
  ```

  The async job mechanics behind this payload are M2–M3.

### `kb_search`

- **M17** — Input `{query, limit?}`. Returns indexed Markdown sections matching the keyword
  query; `limit` (clamped to 1–200) caps the count, defaulting to the API limit when
  omitted.

### `kb_flows`

- **M18** — Input `{}`. Lists the knowledge flows a question can be routed to:
  `{"flows": [{"id": string, "name": string}, ...]}`. Use an id as the `flow` argument to
  `kb_ask` or `kb_outline`.

### `kb_feedback`

- **M19** — Input `{questionId, kind, gapSummary?}` where `kind` is
  `helpful | unhelpful | knowledge_gap`. `helpful`/`unhelpful` record answer-quality
  feedback. `knowledge_gap` flags a gap the system missed (optional `gapSummary` describes
  the missing knowledge) and feeds the same gap-candidate clustering as automatic detection
  ([gaps-and-maintenance.md](./gaps-and-maintenance.md)) — independent of helpful/unhelpful.

### `kb_outline`

- **M20** — Input `{flow, notes?}` (`notes` is an optional steer for this run). Proposes a
  seed plan for a flow by exploring its source repositories — **no topic needed**. It only
  **proposes**: nothing is drafted, and the plan waits behind the review gate. Approve it
  with `kb_seed` or edit it in the console. Mechanics are M4.
- **M21** — Returns the persisted plan
  `{planId, charter?, charterProposed, persona?, personaProposed, items: SeedItem[], rationale?}`,
  where each `SeedItem` is `{title?, targetPath?, coverage: string[], questions?: string[]}`.
  The `*Proposed` flags record that the charter/persona came from the model because the
  flow config lacked one — copy the value into `KNOWLEDGE_FLOWS` to make it permanent.

### `kb_seed`

- **M22** — Input `{plan}` — the plan id (from `kb_outline`'s `planId`, or the console).
  Approving drafts one document per approved item straight into the proposal → pull-request
  pipeline, carrying the plan's run-scoped charter/persona. Returns
  `{planId, jobIds: string[]}` — one enqueued `draft_seed_document` job per approved item.
  See [ai-jobs.md](ai-jobs.md#seeding-a-flow) for the full seeding flow.

### `kb_citation`

- **M23** — Input `{sectionIds}` — 1–20 `sectionId` values from `kb_ask` citations (or
  `kb_search` results). Returns `{sections: DocumentSection[], missing: string[]}`. Each
  section is the **currently indexed** version (the KB may have changed since the answer was
  produced); ids that no longer resolve land in `missing` rather than failing the call — the
  knowledge base changed, so re-ask or use `kb_search`.

### `kb_questionnaire_create`

- **M24** — Input `{name, flow, questions}` — 1–500 questions, one per entry; `flow` ids
  come from `kb_flows`. Creates a [questionnaire](questionnaires.md): a named batch answered
  against one flow's knowledge base with verbatim reuse of previously approved answers while
  the KB sections they cited are unchanged.
- **M25** — Creation is **asynchronous by design**: the tool returns the initial worksheet
  immediately (same shape as `kb_questionnaire_get`). Items the deterministic fast-path
  already confirmed reusable carry answers immediately; everything else
  (fresh/adapted/merged/changed) drips through the `answer_question` queue. The tool never
  waits — re-read with `kb_questionnaire_get` until no items are `pending`/`answering`.

### `kb_questionnaire_get`

- **M26** — Input `{questionnaire}` (the id from `kb_questionnaire_create`). Returns the
  worksheet:

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
        "outcome": "reused | adapted | merged | fresh | changed", // present once matched/answered; changed is legacy (QUESTIONNAIRE_RECONCILE_ENABLED=0) only
        "answer": "string",                    // present once answered
        "confidence": "high | medium | low | unknown", // present once answered; a review badge, not a suppressor
        "changeReason": { "kind": "section_changed | section_missing | new_content", "...": "..." },
        "citations": [ { "path": "...", "heading": "..." } ]
      }
    ]
  }
  ```

  Internal plumbing (question-log ids, reuse links, citation content fingerprints) is
  stripped — the worksheet carries what a reviewing model needs. Reading the worksheet also
  **resumes a stalled answer drip** server-side.

### `kb_questionnaire_approve`

- **M27** — Input `{questionnaire, item?}`. Approving an answer into the match corpus is the
  human/agent act that makes it reusable verbatim next time. Without `item`, bulk-approves
  all reused items (`POST /api/questionnaires/:id/approve-reused`) and returns
  `{approved: number}`. With `item`, approves that single answered item
  (`POST /api/questionnaires/:id/items/:itemId/approve`) and returns `{ok: true}`; the API
  answers **409** unless the item's status is `answered`.

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
| `MCP_API_AUTH_TOKEN` | — | Static service token for downstream API calls. Accepted as an alternative to the client-credentials pair below (see M12). |
| `MCP_API_CLIENT_ID` / `MCP_API_CLIENT_SECRET` | — | Preferred auto-refreshing client-credentials pair for downstream API calls (M12). When set, tokens are minted at the Auth0 issuer's `oauth/token` for the API audience. |

### Auth variables (both transports)

Auth **fails closed** and is shared with the API via the `@magpie/auth` package: it is
required unless `AUTH_REQUIRED=false` is set explicitly. These variables must be configured
whenever auth is enabled (see [Authentication & authorization](#authentication--authorization)).

| Variable | Default | Purpose |
| --- | --- | --- |
| `AUTH_REQUIRED` | `true` (fails closed) | Set `false` to explicitly disable Auth0 bearer-token validation. Any other/unset value keeps auth required. |
| `AUTH0_ISSUER_BASE_URL` | — | Full Auth0 issuer (e.g. `https://your-tenant.eu.auth0.com`). |
| `AUTH0_DOMAIN` | — | Alternative to the issuer base; the issuer becomes `https://<domain>/`. |
| `AUTH0_AUDIENCE` | `https://markdown-magpie.local/api` | API identifier the token must carry. |
| `AUTH0_JWKS_URI` | `https://<domain>/.well-known/jwks.json` | Optional JWKS endpoint override (derived from the trailing-slash-normalised issuer when unset). |
| `MCP_AUTH_TOKEN` | — | stdio only: bearer token presented to the API. Required unless `AUTH_REQUIRED=false` (the stdio server fails fast at startup otherwise). |

## Requirements

- The API must be running and reachable at `API_BASE_URL`.
- A watcher must be running to process AI jobs; otherwise `kb_ask` (`answer_question`) and
  `kb_outline` (`outline_flow_seed`) will time out, `kb_seed`'s (`draft_seed_document`) jobs
  stay queued, and `kb_questionnaire_create`'s fresh/changed items stay
  `pending`/`answering` forever.

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

The server listens on port 4001 by default. The MCP endpoint is at
`http://localhost:4001/mcp` and a health check is at `http://localhost:4001/health`.

## Connecting clients

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

Build first (`npm run build`) so `apps/mcp/dist/main.js` exists, ensure the API and a
watcher are running, then start Claude Code from the repository root and approve the server
when prompted.

### Hermes Agent (Streamable HTTP)

Add to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  markdown-magpie:
    url: "http://localhost:4001/mcp"
    timeout: 180
```

Restart Hermes Agent. Tools appear as `mcp_markdown-magpie_kb_ask`,
`mcp_markdown-magpie_kb_search`, `mcp_markdown-magpie_kb_feedback`, etc.

### Any MCP client (Streamable HTTP)

Point the client at `http://<host>:4001/mcp`. The server implements the MCP Streamable HTTP
transport and is compatible with any spec-compliant client (Claude Desktop, VS Code,
Continue, etc.).

## Code map

| Concern | Code |
| --- | --- |
| stdio transport: framing, JSON-RPC dispatch, tool declarations, `callTool` | `apps/mcp/src/main.ts` |
| stdio auth guard (`resolveStdioAuthToken`) | `apps/mcp/src/main.ts` |
| Streamable HTTP app: OAuth protected-resource metadata, per-tool/batch scope gate, `/mcp`, `/health` | `apps/mcp/src/http.ts` |
| HTTP service credential (client-credentials or static token) + on-behalf-of headers | `apps/mcp/src/http.ts` |
| API proxy client: `askQuestion`, `listFlows`, `getJson`/`postJson`, job wait/poll, `submitFeedback`, `generateOutline`, `approveSeedPlan`, `getCitationSections`, questionnaire calls | `apps/mcp/src/kb-client.ts` |
| Logger (stderr sink for stdio) | `apps/mcp/src/logger.ts` |

## Tests (behavioural contract)

`apps/mcp/src/main.test.ts` (tool list + `callTool` dispatch, stdio auth guard),
`apps/mcp/src/http.test.ts` (transport, OAuth metadata, per-tool and batch-union scope
gating, service credential), `apps/mcp/src/kb-client.test.ts` (API proxying, job
wait/poll fallback, per-tool payload shaping), `apps/mcp/src/logger.test.ts`.

## Provenance (design history)

Consolidates, and supersedes as a behavioural description:
`docs/superpowers/specs/2026-06-18-auth0-mcp-gating-design.md` (auth fail-closed, OAuth
protected-resource, per-tool/batch scope, on-behalf-of delegation),
`2026-07-14-mcp-citation-tool-design.md` (`kb_citation`),
`2026-06-13-manual-knowledge-gap-feedback-design.md` (`kb_feedback` knowledge-gap kind),
`2026-07-03-flow-seeding-design.md` and `2026-07-09-self-seeding-flows-design.md`
(`kb_outline`/`kb_seed` and the source-grounded plan),
`2026-07-16-revise-seed-plan-design.md` (persisted, reviewable seed plans),
`2026-07-16-questionnaire-mode-design.md` and `2026-07-17-questionnaire-trust-design.md`
(`kb_questionnaire_*` batch answering, reuse, and approval).
