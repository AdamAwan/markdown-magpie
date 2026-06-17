import { McpServer } from "@modelcontextprotocol/server";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { z } from "zod/v4";

// ── Configuration ──────────────────────────────────────────────────────────

const apiBaseUrl = trimTrailingSlash(
  (process.env.API_BASE_URL ?? "http://localhost:4000").replace(/\/api$/, "")
);
const port = parseInt(process.env.MCP_HTTP_PORT ?? "4001", 10);

const answerPollIntervalMs = parsePositiveInt(
  process.env.ANSWER_POLL_INTERVAL_MS,
  1000
);
const answerTimeoutMs = parsePositiveInt(
  process.env.ANSWER_TIMEOUT_MS,
  120000
);

// ── API helpers (shared with stdio transport) ──────────────────────────────

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function apiUrl(path: string): string {
  return path.startsWith("/api/") || path === "/api"
    ? `${apiBaseUrl}${path}`
    : `${apiBaseUrl}/api${path}`;
}

function parsePositiveInt(
  value: string | undefined,
  fallback: number
): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(apiUrl(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return readApiResponse(response, path);
}

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(apiUrl(path));
  return readApiResponse(response, path);
}

async function readApiResponse(
  response: Response,
  path: string
): Promise<unknown> {
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`API ${path} failed with ${response.status}: ${text}`);
  }
  return body;
}

// ── kb.ask (polling-aware) ─────────────────────────────────────────────────

interface AskResult {
  answer: string;
  confidence: string;
  citations: unknown[];
  gaps?: unknown[];
  questionId?: string;
}

interface JobView {
  status: string;
  output?: unknown;
  error?: string;
}

async function askQuestion(question: string): Promise<AskResult> {
  const ask = asObject(await postJson("/ask", { question }));
  const questionId =
    typeof ask.questionId === "string" ? ask.questionId : undefined;
  const result =
    ask.result !== undefined
      ? extractAnswer(ask.result)
      : await waitForQueuedAnswer(readStatusPath(ask));

  return { ...result, questionId };
}

async function waitForQueuedAnswer(statusPath: string): Promise<AskResult> {
  const deadline = Date.now() + answerTimeoutMs;

  for (;;) {
    const job = readJob(await getJson(statusPath));

    if (job.status === "completed") {
      if (job.output === undefined) {
        throw new Error("Answer job completed without producing an answer");
      }
      return extractAnswer(job.output);
    }

    if (job.status === "failed" || job.status === "cancelled") {
      throw new Error(job.error ?? `Answer job ${job.status}`);
    }

    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the answer to be generated");
    }

    await delay(answerPollIntervalMs);
  }
}

function readStatusPath(ask: Record<string, unknown>): string {
  const links = ask.links;
  if (links && typeof links === "object") {
    const status = (links as Record<string, unknown>).status;
    if (typeof status === "string" && status.length > 0) {
      return status;
    }
  }
  throw new Error("Queued answer response did not include a status link");
}

function readJob(value: unknown): JobView {
  const job = asObject(asObject(value).job);
  const status = job.status;
  if (typeof status !== "string") {
    throw new Error("Job status response did not include a status");
  }
  return {
    status,
    output: job.output,
    error: typeof job.error === "string" ? job.error : undefined,
  };
}

function extractAnswer(value: unknown): AskResult {
  const record = asObject(value);
  const answer = record.answer;
  if (typeof answer !== "string") {
    throw new Error("Answer payload did not include answer text");
  }
  const result: AskResult = {
    answer,
    confidence:
      typeof record.confidence === "string" ? record.confidence : "low",
    citations: Array.isArray(record.citations) ? record.citations : [],
  };
  if (Array.isArray(record.gaps) && record.gaps.length > 0) {
    result.gaps = record.gaps;
  }
  return result;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error("Expected an object response from the API");
  }
  return value as Record<string, unknown>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── kb.feedback ────────────────────────────────────────────────────────────

type FeedbackKind = "helpful" | "unhelpful" | "knowledge_gap";

function feedbackKindArgument(
  args: Record<string, unknown> | undefined
): FeedbackKind {
  const value = args?.kind;
  if (
    value === "helpful" ||
    value === "unhelpful" ||
    value === "knowledge_gap"
  ) {
    return value;
  }
  throw new Error(
    "kind must be one of 'helpful', 'unhelpful', or 'knowledge_gap'"
  );
}

function stringArgument(
  args: Record<string, unknown> | undefined,
  name: string
): string {
  const value = args?.[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function optionalStringArgument(
  args: Record<string, unknown> | undefined,
  name: string
): string | undefined {
  const value = args?.[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function submitFeedback(
  args: Record<string, unknown> | undefined
): Promise<unknown> {
  const questionId = stringArgument(args, "questionId");
  const kind = feedbackKindArgument(args);

  if (kind === "knowledge_gap") {
    const gapSummary = optionalStringArgument(args, "gapSummary");
    const body = gapSummary ? { summary: gapSummary } : {};
    const response = asObject(
      await postJson(`/questions/${encodeURIComponent(questionId)}/gap`, body)
    );
    return { questionId, kind, question: response.question };
  }

  const response = asObject(
    await postJson(
      `/questions/${encodeURIComponent(questionId)}/feedback`,
      { feedback: kind }
    )
  );
  return { questionId, kind, question: response.question };
}

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
          ? `/search?q=${encodeURIComponent(query)}&limit=${limit}`
          : `/search?q=${encodeURIComponent(query)}`;
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

  const app = createMcpExpressApp({
    host: "0.0.0.0", // container-friendly; set MCP_HTTP_HOST to override
  });

  // POST: client sends JSON-RPC requests
  app.post("/mcp", async (req: any, res: any) => {
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
  app.get("/mcp", async (req: any, res: any) => {
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
  app.delete("/mcp", async (req: any, res: any) => {
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
  app.get("/health", (_req: any, res: any) => {
    res.json({ status: "ok" });
  });

  const host = process.env.MCP_HTTP_HOST ?? "0.0.0.0";
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
