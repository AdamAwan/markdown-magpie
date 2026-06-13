import { stdin, stdout } from "node:process";

const apiBaseUrl = trimTrailingSlash(process.env.API_BASE_URL ?? "http://localhost:4000");

// When the API answers questions asynchronously (queue execution mode), kb.ask
// polls the job until it produces an answer instead of returning queue metadata.
const answerPollIntervalMs = parsePositiveInt(process.env.ANSWER_POLL_INTERVAL_MS, 1000);
const answerTimeoutMs = parsePositiveInt(process.env.ANSWER_TIMEOUT_MS, 120000);

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

interface AskResult {
  answer: string;
  confidence: string;
  citations: unknown[];
  gap?: unknown;
}

interface JobView {
  status: string;
  output?: unknown;
  error?: string;
}

// Asks the API a question and resolves to the final answer only. The API may
// answer inline (direct mode) or asynchronously via a job (queue mode); in the
// queue case we poll until the answer is ready so callers never see internal
// job, queue, or retrieval-context details.
async function askQuestion(question: string): Promise<AskResult> {
  const ask = asObject(await postJson("/ask", { question }));

  if (ask.result !== undefined) {
    return extractAnswer(ask.result);
  }

  return waitForQueuedAnswer(readStatusPath(ask));
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
    error: typeof job.error === "string" ? job.error : undefined
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
    confidence: typeof record.confidence === "string" ? record.confidence : "low",
    citations: Array.isArray(record.citations) ? record.citations : []
  };

  if (record.gap !== undefined) {
    result.gap = record.gap;
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
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
  stdout.write(`${JSON.stringify(message)}\n`);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
