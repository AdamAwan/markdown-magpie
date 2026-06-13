# MCP Server

`@magpie/mcp` (`apps/mcp`) is a thin [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI agents and MCP-aware clients ask questions against the indexed Markdown knowledge base. It is a client surface over the HTTP API — it holds no state of its own and proxies every request to the API at `API_BASE_URL`.

## Transport

The server uses the MCP **stdio transport**: each JSON-RPC message is a single line of UTF-8 JSON terminated by a newline, with no embedded newlines (per the [MCP transports spec](https://modelcontextprotocol.io/docs/concepts/transports)). The client launches the server as a subprocess and exchanges messages over stdin/stdout. Logging goes to stderr.

## Tools

### `kb.ask`

Input: `{ "question": string }`

Returns the final answer only:

```json
{
  "answer": "string",
  "confidence": "high | medium | low",
  "citations": [ { "documentId": "...", "sectionId": "...", "path": "...", "heading": "...", "anchor": "...", "excerpt": "..." } ],
  "gap": { ... }   // present only when the answer is a knowledge gap
}
```

The API supports two execution modes:

- **direct** — the API answers inline and the server returns the answer immediately.
- **queue** — the API enqueues a background job (processed by a watcher). The server polls the job's status endpoint until it completes, then returns the finished answer.

In both modes the client receives only the answer payload above. Internal details — execution mode, question/job identifiers, retrieval context, provider names, and status links — are never exposed to the client.

### `kb.search`

Input: `{ "query": string, "limit"?: number }`

Returns indexed Markdown sections matching the keyword query.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `API_BASE_URL` | `http://localhost:4000` | Base URL of the Markdown Magpie API. |
| `ANSWER_POLL_INTERVAL_MS` | `1000` | How often `kb.ask` polls a queued answer job. |
| `ANSWER_TIMEOUT_MS` | `120000` | How long `kb.ask` waits for a queued answer before failing. |

## Requirements

- The API must be running and reachable at `API_BASE_URL`.
- In `queue` execution mode, a watcher must be running to process `answer_question` jobs; otherwise `kb.ask` will time out.

## Running

```bash
npm run build            # produces apps/mcp/dist/main.js
API_BASE_URL=http://localhost:4000 node apps/mcp/dist/main.js
```

Under Docker Compose, the server is available via the `mcp` profile:

```bash
docker compose --profile mcp run --rm mcp
```

## Connecting Claude Code

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
