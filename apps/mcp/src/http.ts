import { McpServer } from "@modelcontextprotocol/server";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { Request, Response } from "express";
import { z } from "zod/v4";
import { askQuestion, getJson, submitFeedback } from "./kb-client.js";

// ── Configuration ──────────────────────────────────────────────────────────

const port = parseInt(process.env.MCP_HTTP_PORT ?? "4001", 10);

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const server = new McpServer({
    name: "markdown-magpie",
    version: "0.1.0",
  });

  server.registerTool(
    "kb.ask",
    {
      description:
        "Ask a question against the indexed Markdown knowledge base and return a cited answer.",
      inputSchema: z.object({
        question: z.string().describe(
          "The question to answer from indexed Markdown context."
        ),
      }),
    },
    async ({ question }) => {
      const result = await askQuestion(question);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "kb.search",
    {
      description: "Search indexed Markdown sections by keyword query.",
      inputSchema: z.object({
        query: z.string().describe("The search query."),
        limit: z
          .number()
          .optional()
          .describe(
            "Maximum number of sections to return. Defaults to the API limit."
          ),
      }),
    },
    async ({ query, limit }) => {
      const path =
        limit !== undefined
          ? `/knowledge/search?q=${encodeURIComponent(query)}&limit=${limit}`
          : `/knowledge/search?q=${encodeURIComponent(query)}`;
      const result = await getJson(path);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "kb.feedback",
    {
      description:
        "Report feedback on a previously asked question using the questionId returned by kb.ask. " +
        "kind is 'helpful', 'unhelpful', or 'knowledge_gap'. For 'knowledge_gap', optionally pass " +
        "gapSummary describing the missing knowledge.",
      inputSchema: z.object({
        questionId: z.string().describe("The questionId returned by kb.ask."),
        kind: z
          .enum(["helpful", "unhelpful", "knowledge_gap"])
          .describe("The kind of feedback to record."),
        gapSummary: z
          .string()
          .optional()
          .describe(
            "Optional summary of the missing knowledge. Only used when kind is 'knowledge_gap'."
          ),
      }),
    },
    async (args) => {
      const result = await submitFeedback(
        args as Record<string, unknown> | undefined
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  // Stateless transport — each request is independent.
  // Omit sessionIdGenerator so the SDK treats it as stateless.
  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await server.connect(transport);

  // Bind to loopback by default; require an explicit opt-in (e.g.
  // MCP_HTTP_HOST=0.0.0.0) to expose the server on all interfaces. Passing the
  // host to createMcpExpressApp also keeps DNS-rebinding protection enabled for
  // localhost binds.
  const host = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
  const app = createMcpExpressApp({ host });

  // POST: client sends JSON-RPC requests
  app.post("/mcp", async (req: Request, res: Response) => {
    try {
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        const message =
          err instanceof Error ? err.message : "Internal server error";
        res.status(500).json({ error: message });
      }
    }
  });

  // GET: server-initiated messages via SSE
  app.get("/mcp", async (req: Request, res: Response) => {
    try {
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) {
        const message =
          err instanceof Error ? err.message : "Internal server error";
        res.status(500).json({ error: message });
      }
    }
  });

  // DELETE: session teardown
  app.delete("/mcp", async (req: Request, res: Response) => {
    try {
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) {
        const message =
          err instanceof Error ? err.message : "Internal server error";
        res.status(500).json({ error: message });
      }
    }
  });

  // Health check
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  app.listen(port, host, () => {
    console.error(
      `markdown-magpie MCP (Streamable HTTP) listening on ${host}:${port}`
    );
  });
}

main().catch((err) => {
  console.error("MCP HTTP fatal:", err);
  process.exit(1);
});
