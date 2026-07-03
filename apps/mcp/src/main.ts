import { argv, stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { isAuthRequired } from "@magpie/auth";
import { askQuestion, getJson, listFlows, optionalStringArgument, seedFlow, stringArgument, submitFeedback } from "./kb-client.js";
import { createMcpLogger } from "./logger.js";

type JsonRpcId = string | number | null;

// Bearer token the stdio transport presents to the API on every call. Distinct
// from the HTTP transport's MCP_API_AUTH_TOKEN service token. Undefined only when
// auth is explicitly disabled (AUTH_REQUIRED=false), which keeps local-dev calls
// unauthenticated. Resolved inside main() once the auth guard has run.
let stdioAuthToken: string | undefined;

// Validates that a stdio token is present when auth is required. Auth fails
// CLOSED (see isAuthRequired in @magpie/auth): it is required unless an operator
// explicitly sets AUTH_REQUIRED=false, so an unset/blank/typo'd value keeps the
// token mandatory rather than silently calling the API unauthenticated. Pure
// (operates on a supplied env object) so the guard is unit-testable without
// spawning the process; returns the token to use, or throws a clear message that
// the startup path turns into a non-zero exit.
export function resolveStdioAuthToken(env: NodeJS.ProcessEnv): string | undefined {
  const authRequired = isAuthRequired(env.AUTH_REQUIRED);
  const token = env.MCP_AUTH_TOKEN;
  if (authRequired && !token) {
    throw new Error("MCP_AUTH_TOKEN is required unless AUTH_REQUIRED=false for stdio MCP.");
  }

  return token;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface ToolCallParams {
  name?: string;
  arguments?: Record<string, unknown>;
}

interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

const tools = [
  {
    name: "kb_ask",
    description:
      "Ask a question against the indexed Markdown knowledge base and return a cited answer. " +
      "By default (flow 'auto') the question is routed to the best-matching knowledge flow. " +
      "If routing cannot determine a flow, the result has flowSelectionRequired with the available " +
      "flows — call kb_ask again with `flow` set to one of those ids. Use kb_flows to discover flows up front.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to answer from indexed Markdown context."
        },
        flow: {
          type: "string",
          description:
            "Flow to answer within. Defaults to 'auto' (let the router decide). Otherwise must be a flow id from kb_flows."
        }
      },
      required: ["question"],
      additionalProperties: false
    } satisfies JsonSchema
  },
  {
    name: "kb_flows",
    description:
      "List the knowledge flows a question can be routed to. Use the returned ids as the `flow` argument to kb_ask.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    } satisfies JsonSchema
  },
  {
    name: "kb_search",
    description: "Search indexed Markdown sections by keyword query.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query."
        },
        limit: {
          type: "number",
          description: "Maximum number of sections to return. Defaults to the API limit."
        }
      },
      required: ["query"],
      additionalProperties: false
    } satisfies JsonSchema
  },
  {
    name: "kb_feedback",
    description:
      "Report feedback on a previously asked question using the questionId returned by kb_ask. " +
      "kind is 'helpful', 'unhelpful', or 'knowledge_gap'. For 'knowledge_gap', optionally pass " +
      "gapSummary describing the missing knowledge.",
    inputSchema: {
      type: "object",
      properties: {
        questionId: {
          type: "string",
          description: "The questionId returned by kb_ask."
        },
        kind: {
          type: "string",
          enum: ["helpful", "unhelpful", "knowledge_gap"],
          description: "The kind of feedback to record."
        },
        gapSummary: {
          type: "string",
          description: "Optional summary of the missing knowledge. Only used when kind is 'knowledge_gap'."
        }
      },
      required: ["questionId", "kind"],
      additionalProperties: false
    } satisfies JsonSchema
  },
  {
    name: "kb_seed",
    description:
      "Seed a flow with initial content: submit a list of documents to author, each a title plus the points it should cover. " +
      "Each is drafted straight into a proposal → pull request, skipping the gap-clustering pipeline. " +
      "Use for a brand-new flow or to add a new area of knowledge (e.g. a new feature) to an existing one. Discover flow ids with kb_flows.",
    inputSchema: {
      type: "object",
      properties: {
        flow: {
          type: "string",
          description: "The flow id to seed (from kb_flows)."
        },
        items: {
          type: "array",
          description: "One entry per document to author.",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Optional document title." },
              targetPath: { type: "string", description: "Optional destination-relative path." },
              coverage: {
                type: "array",
                items: { type: "string" },
                description: "The points this document must cover. At least one."
              },
              questions: {
                type: "array",
                items: { type: "string" },
                description: "Optional motivating questions/prompts for context."
              }
            },
            required: ["coverage"],
            additionalProperties: false
          }
        }
      },
      required: ["flow", "items"],
      additionalProperties: false
    } satisfies JsonSchema
  }
];

let inputBuffer = Buffer.alloc(0);

const logger = createMcpLogger("stdio");

// Bootstraps the stdio MCP server: enforces the auth guard, resolves the bearer
// token, and wires up the stdin reader. Runs only when this module is launched
// as the entrypoint (see the guard at the bottom), so importing it (e.g. from
// tests) has no side effects.
function main(): void {
  try {
    stdioAuthToken = resolveStdioAuthToken(process.env);
  } catch (error) {
    logger.error({ err: error }, error instanceof Error ? error.message : "Invalid stdio MCP auth configuration.");
    process.exit(1);
  }

  stdin.on("data", (chunk: Buffer) => {
    inputBuffer = Buffer.concat([inputBuffer, chunk]);
    void drainMessages();
  });

  stdin.on("error", (error) => {
    logger.error({ err: error }, `MCP stdin error: ${error.message}`);
  });
}

async function drainMessages(): Promise<void> {
  for (;;) {
    const message = readMessage();
    if (!message) {
      return;
    }

    try {
      await handleMessage(message);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "Unexpected MCP error";
      logger.error({ err: error }, messageText);
    }
  }
}

// The MCP stdio transport frames each JSON-RPC message as a single line of
// UTF-8 JSON terminated by a newline; messages must not contain embedded
// newlines. See https://modelcontextprotocol.io/docs/concepts/transports.
function readMessage(): JsonRpcRequest | undefined {
  for (;;) {
    const newlineIndex = inputBuffer.indexOf(0x0a);
    if (newlineIndex === -1) {
      return undefined;
    }

    const line = inputBuffer.subarray(0, newlineIndex).toString("utf8").replace(/\r$/, "");
    inputBuffer = inputBuffer.subarray(newlineIndex + 1);

    if (line.trim().length === 0) {
      continue;
    }

    return JSON.parse(line) as JsonRpcRequest;
  }
}

async function handleMessage(message: JsonRpcRequest): Promise<void> {
  if (message.id === undefined) {
    return;
  }

  try {
    const result = await dispatch(message);
    writeMessage({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "Unexpected MCP request failure";
    writeMessage({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32603,
        message: messageText
      }
    });
  }
}

async function dispatch(message: JsonRpcRequest): Promise<unknown> {
  if (message.method === "initialize") {
    return {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {}
      },
      serverInfo: {
        name: "markdown-magpie",
        version: "0.1.0"
      }
    };
  }

  if (message.method === "ping") {
    return {};
  }

  if (message.method === "tools/list") {
    return { tools };
  }

  if (message.method === "tools/call") {
    return callTool(asToolCallParams(message.params));
  }

  throw new Error(`Unsupported MCP method: ${message.method}`);
}

async function callTool(params: ToolCallParams): Promise<unknown> {
  if (params.name === "kb_ask") {
    const question = stringArgument(params.arguments, "question");
    const flow = optionalStringArgument(params.arguments, "flow");
    const answer = await askQuestion(question, { token: stdioAuthToken }, flow);
    return textResult(answer);
  }

  if (params.name === "kb_flows") {
    const result = await listFlows({ token: stdioAuthToken });
    return textResult(result);
  }

  if (params.name === "kb_search") {
    const query = stringArgument(params.arguments, "query");
    const limit = numberArgument(params.arguments, "limit");
    const path = limit === undefined ? `/knowledge/search?q=${encodeURIComponent(query)}` : `/knowledge/search?q=${encodeURIComponent(query)}&limit=${limit}`;
    const result = await getJson(path, { token: stdioAuthToken });
    return textResult(result);
  }

  if (params.name === "kb_feedback") {
    const result = await submitFeedback(params.arguments, { token: stdioAuthToken });
    return textResult(result);
  }

  if (params.name === "kb_seed") {
    const result = await seedFlow(params.arguments, { token: stdioAuthToken });
    return textResult(result);
  }

  throw new Error(`Unknown tool: ${params.name ?? "(missing)"}`);
}

function asToolCallParams(value: unknown): ToolCallParams {
  if (!value || typeof value !== "object") {
    return {};
  }

  return value as ToolCallParams;
}

function numberArgument(args: Record<string, unknown> | undefined, name: string): number | undefined {
  const value = args?.[name];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a number`);
  }

  return Math.max(1, Math.min(Math.trunc(value), 200));
}

function textResult(value: unknown): unknown {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function writeMessage(message: unknown): void {
  stdout.write(`${JSON.stringify(message)}\n`);
}

// Only start the stdio server when run directly (e.g. `node dist/main.js`).
// Importing this module (tests) must not run the auth guard, exit the process,
// or register the stdin reader that would keep the event loop alive.
if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main();
}
