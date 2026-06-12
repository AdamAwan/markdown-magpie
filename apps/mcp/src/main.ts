import { stdin, stdout } from "node:process";

const apiBaseUrl = trimTrailingSlash(process.env.API_BASE_URL ?? "http://localhost:4000");

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

function readMessage(): JsonRpcRequest | undefined {
  const headerEnd = inputBuffer.indexOf("\r\n\r\n");
  if (headerEnd === -1) {
    return undefined;
  }

  const header = inputBuffer.subarray(0, headerEnd).toString("utf8");
  const contentLength = /^Content-Length:\s*(\d+)$/im.exec(header)?.[1];
  if (!contentLength) {
    throw new Error("MCP message is missing Content-Length");
  }

  const bodyLength = Number.parseInt(contentLength, 10);
  const bodyStart = headerEnd + 4;
  const bodyEnd = bodyStart + bodyLength;
  if (inputBuffer.length < bodyEnd) {
    return undefined;
  }

  const body = inputBuffer.subarray(bodyStart, bodyEnd).toString("utf8");
  inputBuffer = inputBuffer.subarray(bodyEnd);
  return JSON.parse(body) as JsonRpcRequest;
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
    const result = await postJson("/ask", { question });
    return textResult(result);
  }

  if (params.name === "kb.search") {
    const query = stringArgument(params.arguments, "query");
    const limit = numberArgument(params.arguments, "limit");
    const path = limit === undefined ? `/search?q=${encodeURIComponent(query)}` : `/search?q=${encodeURIComponent(query)}&limit=${limit}`;
    const result = await getJson(path);
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

function stringArgument(args: Record<string, unknown> | undefined, name: string): string {
  const value = args?.[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }

  return value.trim();
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

async function postJson(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  return readApiResponse(response, path);
}

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(`${apiBaseUrl}${path}`);
  return readApiResponse(response, path);
}

async function readApiResponse(response: Response, path: string): Promise<unknown> {
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(`API ${path} failed with ${response.status}: ${text}`);
  }

  return body;
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
  const body = JSON.stringify(message);
  stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
