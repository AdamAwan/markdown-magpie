# MCP Server

`@magpie/mcp` (`apps/mcp`) is a thin [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI agents and MCP-aware clients ask questions against the indexed Markdown knowledge base. It is a client surface over the HTTP API — it holds no state of its own and proxies every request to the API at `API_BASE_URL`.

## Transports

The server supports two standard MCP transports:

### stdio (local subprocess)

Uses the MCP **stdio transport**: each JSON-RPC message is a single line of UTF-8 JSON terminated by a newline, with no embedded newlines (per the [MCP transports spec](https://modelcontextprotocol.io/docs/concepts/transports)). The client launches the server as a subprocess and exchanges messages over stdin/stdout. Logging goes to stderr.

### Streamable HTTP (network)

Uses the MCP **Streamable HTTP transport** (spec version 2025-03-26+). Runs as a long-lived HTTP server on a configurable port. Clients send JSON-RPC requests via HTTP POST and receive responses via JSON or Server-Sent Events (SSE). This transport is built on the official `@modelcontextprotocol/server` SDK and supports both stateful and stateless modes.

## Tools

### `kb.ask`

Input: `{ "question": string }`

Returns the final answer only:

```json
{
  "answer": "string",
  "confidence": "high | medium | low",
  "citations": [ { "documentId": "...", "sectionId": "...", "path": "...", "heading": "...", "anchor": "...", "excerpt": "..." } ],
  "gaps": [ { ... } ],   // present only when the answer exposes knowledge gaps; one entry per missing topic
  "questionId": "string" // identifier for reporting feedback via kb.feedback
}
```

Answers are always produced asynchronously by a durable job:

1. `POST /api/ask` records the question and enqueues an `answer_question` job, returning **202** with `{ questionId, job, links }` — no inline answer.
2. The server waits on the job via `GET /api/jobs/:id/wait`. The wait endpoint long-polls server-side and returns **200** with the terminal job, or **202** with the current projection when its wait limit expires.
3. If the wait returns a non-terminal job (state `created`, `retry`, or `active`), the server falls back to polling the detail endpoint `GET /api/jobs/:id` every `ANSWER_POLL_INTERVAL_MS` until the job reaches a terminal state or `ANSWER_TIMEOUT_MS` elapses.

Job states are `created | retry | active` (non-terminal) and `completed | cancelled | failed` (terminal). On `completed`, the terminal job `output` is the envelope `{ result, executor }`; the answer fields live in `result`. On `failed`/`cancelled`, or if the timeout is exceeded, `kb.ask` raises an error naming the job id and state (no payload data is echoed).

The client receives only the answer payload above plus the `questionId`. Internal details — job identifiers, retrieval context, provider names, and status links — are not exposed to the client.

### `kb.search`

Input: `{ "query": string, "limit"?: number }`

Returns indexed Markdown sections matching the keyword query.

### `kb.feedback`

Reports feedback on a previously asked question, using the `questionId` returned by `kb.ask`.

Input:

```json
{
  "questionId": "string",
  "kind": "helpful | unhelpful | knowledge_gap",
  "gapSummary": "string"   // optional; only used when kind is "knowledge_gap"
}
```

`helpful` / `unhelpful` record answer-quality feedback. `knowledge_gap` flags the question as a knowledge gap the system missed (the optional `gapSummary` describes the missing knowledge); this is independent of helpful/unhelpful and feeds the same gap-candidate clustering as automatic detection.

## Configuration

### Common (all transports)

| Variable | Default | Purpose |
| --- | --- | --- |
| `API_BASE_URL` | `http://localhost:4000` | Base URL of the Markdown Magpie API. |
| `ANSWER_POLL_INTERVAL_MS` | `1000` | How often `kb.ask` polls the answer job's detail endpoint after a non-terminal wait. |
| `ANSWER_TIMEOUT_MS` | `120000` | How long `kb.ask` waits for a queued answer before failing. |

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

Per-tool scopes:

| Tool | Required scope |
| --- | --- |
| `kb.search` | `read:knowledge` |
| `kb.ask` | `ask:knowledge` |
| `kb.feedback` | `feedback:questions` |

The inbound user token is validated locally and **never forwarded** to the API. The HTTP server calls the API with its own separate service token, `MCP_API_AUTH_TOKEN` (a machine-to-machine credential). Startup fails fast if `AUTH_REQUIRED=true` and this token is missing.

### stdio

The stdio transport presents a single bearer token to the API on every call, supplied via `MCP_AUTH_TOKEN`. When `AUTH_REQUIRED=true` and the token is missing, the server fails fast at startup with a non-zero exit.

## Requirements

- The API must be running and reachable at `API_BASE_URL`.
- A watcher must be running to process `answer_question` jobs; otherwise `kb.ask` will time out.

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
