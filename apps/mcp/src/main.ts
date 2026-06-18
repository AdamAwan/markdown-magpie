import { stdin, stdout } from "node:process";
import { askQuestion, getJson, stringArgument, submitFeedback } from "./kb-client.js";

type JsonRpcId = string | number | null;

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
    name: "kb.ask",
    description: "Ask a question against the indexed Markdown knowledge base and return a cited answer.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to answer from indexed Markdown context."
        }
      },
      required: ["question"],
      additionalProperties: false
    } satisfies JsonSchema
  },
  {
    name: "kb.search",
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
    name: "kb.feedback",
    description:
      "Report feedback on a previously asked question using the questionId returned by kb.ask. " +
      "kind is 'helpful', 'unhelpful', or 'knowledge_gap'. For 'knowledge_gap', optionally pass " +
      "gapSummary describing the missing knowledge.",
    inputSchema: {
      type: "object",
      properties: {
        questionId: {
          type: "string",
          description: "The questionId returned by kb.ask."
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
  }
];

let inputBuffer = Buffer.alloc(0);

stdin.on("data", (chunk: Buffer) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  void drainMessages();
});

stdin.on("error", (error) => {
  console.error(`MCP stdin error: ${error.message}`);
});

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
      console.error(messageText);
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
  if (params.name === "kb.ask") {
    const question = stringArgument(params.arguments, "question");
    const answer = await askQuestion(question);
    return textResult(answer);
  }

  if (params.name === "kb.search") {
    const query = stringArgument(params.arguments, "query");
    const limit = numberArgument(params.arguments, "limit");
    const path = limit === undefined ? `/knowledge/search?q=${encodeURIComponent(query)}` : `/knowledge/search?q=${encodeURIComponent(query)}&limit=${limit}`;
    const result = await getJson(path);
    return textResult(result);
  }

  if (params.name === "kb.feedback") {
    const result = await submitFeedback(params.arguments);
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
