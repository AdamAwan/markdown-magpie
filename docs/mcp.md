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

The API supports two execution modes:

- **direct** — the API answers inline and the server returns the answer immediately.
- **queue** — the API enqueues a background job (processed by a watcher). The server polls the job's status endpoint until it completes, then returns the finished answer.

In both modes the client receives the answer payload above plus the `questionId`. Other internal details — execution mode, job identifiers, retrieval context, provider names, and status links — are not exposed to the client.

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
| `ANSWER_POLL_INTERVAL_MS` | `1000` | How often `kb.ask` polls a queued answer job. |
| `ANSWER_TIMEOUT_MS` | `120000` | How long `kb.ask` waits for a queued answer before failing. |

### Streamable HTTP only

| Variable | Default | Purpose |
| --- | --- | --- |
| `MCP_HTTP_PORT` | `4001` | Port the HTTP server listens on. |
| `MCP_HTTP_HOST` | `0.0.0.0` | Host interface to bind to. |

## Requirements

- The API must be running and reachable at `API_BASE_URL`.
- In `queue` execution mode, a watcher must be running to process `answer_question` jobs; otherwise `kb.ask` will time out.

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

Build first (`npm run build`) so `apps/mcp/dist/main.js` exists, ensure the API (and a watcher, in queue mode) are running, then start Claude Code from the repository root and approve the server when prompted.

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
