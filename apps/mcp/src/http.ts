import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { Express, Request, Response } from "express";
import {
  AuthError,
  authSettingsFromEnv,
  createApiTokenProvider,
  createRemoteAuthVerifier,
  hasScopes,
  parseBearerToken,
  type ApiTokenProvider,
  type AuthSettings,
  type Principal
} from "@magpie/auth";
import type { JSONWebKeySet } from "jose";
import { z } from "zod/v4";
import { askQuestion, getJson, submitFeedback, type KbClientOptions } from "./kb-client.js";
import { createMcpLogger } from "./logger.js";

// ── Configuration ──────────────────────────────────────────────────────────

const port = parseInt(process.env.MCP_HTTP_PORT ?? "4001", 10);

const SCOPES_SUPPORTED = ["read:knowledge", "ask:knowledge", "feedback:questions"] as const;

// Per-tool scope requirements enforced at the MCP boundary, mirroring the API
// route scopes. tools/list and other methods need only a valid token.
const TOOL_SCOPES: Record<string, string> = {
  "kb.search": "read:knowledge",
  "kb.ask": "ask:knowledge",
  "kb.feedback": "feedback:questions"
};

// Resolves the auth settings the HTTP MCP server validates inbound tokens with.
//
// Critically, the MCP server has its OWN audience, distinct from the web API
// audience (AUTH0_AUDIENCE). MCP clients (Claude, Cursor, MCP Inspector) request
// a token using the RFC 8707 `resource` parameter set to the /mcp URL, so Auth0
// stamps `aud` = the /mcp URL. Validating those tokens against AUTH0_AUDIENCE (the
// web API identifier) would reject every correctly-issued MCP token with a 401.
// The audience therefore comes from MCP_AUDIENCE, defaulting to the public /mcp
// resource URL. The web API (apps/api) is unchanged and still validates against
// AUTH0_AUDIENCE.
export function mcpAuthSettingsFromEnv(env: NodeJS.ProcessEnv, resourceUrl: string): AuthSettings {
  return { ...authSettingsFromEnv(env), audience: env.MCP_AUDIENCE ?? resourceUrl };
}

export interface HttpMcpOptions {
  auth: AuthSettings & { jwks?: () => Promise<JSONWebKeySet> };
  // The public URL of this protected resource (the /mcp endpoint). Used for the
  // protected-resource metadata document and the discovery challenge.
  resourceUrl: string;
  // Service credential used for downstream API calls. The inbound user token is
  // NEVER forwarded; this is a separate M2M credential. Provide EITHER a static
  // token (`apiToken`, legacy MCP_API_AUTH_TOKEN) OR client-credentials so the
  // server fetches and refreshes its own token at runtime (preferred — static
  // Auth0 tokens expire ~24h after deploy). When both are given, the
  // client-credentials config wins.
  apiToken?: string;
  apiClientId?: string;
  apiClientSecret?: string;
  apiTokenUrl?: string;
  apiAudience?: string;
}

// ── App factory ──────────────────────────────────────────────────────────────

const logger = createMcpLogger("http");

export function createHttpMcpApp(options: HttpMcpOptions): Express {
  // Resolve the downstream service token lazily so an expired M2M token is
  // refreshed transparently between tool calls. The inbound user token is never
  // forwarded — this credential is entirely separate.
  const apiTokenProvider: ApiTokenProvider = createApiTokenProvider({
    staticToken: options.apiToken,
    clientId: options.apiClientId,
    clientSecret: options.apiClientSecret,
    tokenUrl: options.apiTokenUrl,
    audience: options.apiAudience
  });
  const kbOptions: KbClientOptions = { token: apiTokenProvider };

  const server = new McpServer({
    name: "markdown-magpie",
    version: "0.1.0"
  });

  server.registerTool(
    "kb.ask",
    {
      description:
        "Ask a question against the indexed Markdown knowledge base and return a cited answer.",
      inputSchema: z.object({
        question: z.string().describe(
          "The question to answer from indexed Markdown context."
        )
      })
    },
    async ({ question }) => {
      const result = await askQuestion(question, kbOptions);
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
          )
      })
    },
    async ({ query, limit }) => {
      const path =
        limit !== undefined
          ? `/knowledge/search?q=${encodeURIComponent(query)}&limit=${limit}`
          : `/knowledge/search?q=${encodeURIComponent(query)}`;
      const result = await getJson(path, kbOptions);
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
          )
      })
    },
    async (args) => {
      const result = await submitFeedback(args, kbOptions);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  // Stateless transport — each request is independent.
  // Omit sessionIdGenerator so the SDK treats it as stateless.
  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });

  // Start connecting eagerly but await it lazily inside `handle` (see below), so
  // that importing this module (e.g. from tests) never boots a live connection.
  // Any connect rejection is surfaced through the per-request try/catch as a 500.
  const connected = server.connect(transport);

  // Bind to loopback by default; require an explicit opt-in (e.g.
  // MCP_HTTP_HOST=0.0.0.0) to expose the server on all interfaces. Passing the
  // host to createMcpExpressApp also keeps DNS-rebinding protection enabled for
  // localhost binds.
  const host = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
  const app = createMcpExpressApp({ host });

  // ── OAuth protected-resource metadata ─────────────────────────────────────
  const metadata = {
    resource: options.resourceUrl,
    authorization_servers: [options.auth.issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: [...SCOPES_SUPPORTED]
  };

  // The discovery URL is derived from the resource origin so we never hardcode
  // the production host (RFC 9728 §3.1 anchors it at the resource's origin).
  const metadataUrl = `${new URL(options.resourceUrl).origin}/.well-known/oauth-protected-resource`;

  const serveMetadata = (_req: Request, res: Response): void => {
    res.json(metadata);
  };
  app.get("/.well-known/oauth-protected-resource", serveMetadata);
  app.get("/.well-known/oauth-protected-resource/mcp", serveMetadata);

  const verifier = options.auth.required ? createRemoteAuthVerifier(options.auth) : undefined;

  function challenge(res: Response): void {
    res
      .status(401)
      .set("WWW-Authenticate", `Bearer resource_metadata="${metadataUrl}"`)
      .json({ error: "unauthorized" });
  }

  // Validates the inbound token (when auth is required) and, for tools/call,
  // enforces the per-tool scope. Returns true when the request may proceed to
  // the transport; otherwise it has already written the response.
  async function authorize(req: Request, res: Response): Promise<boolean> {
    if (!verifier) {
      return true;
    }

    let principal: Principal;
    try {
      principal = await verifier.verify(parseBearerToken(req.header("authorization")));
    } catch (error) {
      if (error instanceof AuthError) {
        challenge(res);
        return false;
      }
      throw error;
    }

    const requiredScope = requiredToolScope(req);
    if (requiredScope && !hasScopes(principal, [requiredScope])) {
      res.status(403).json({ error: "forbidden" });
      return false;
    }

    return true;
  }

  const handle = async (req: Request, res: Response, body?: unknown): Promise<void> => {
    const startMs = Date.now();
    try {
      if (!(await authorize(req, res))) {
        logger.info({ method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - startMs }, "request completed");
        return;
      }
      await connected;
      await transport.handleRequest(req, res, body);
      logger.info({ method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - startMs }, "request completed");
    } catch (err) {
      if (!res.headersSent) {
        const message = err instanceof Error ? err.message : "Internal server error";
        res.status(500).json({ error: message });
      }
      logger.error({ err, method: req.method, path: req.path, status: 500, durationMs: Date.now() - startMs }, "request error");
    }
  };

  // POST: client sends JSON-RPC requests
  app.post("/mcp", (req: Request, res: Response) => {
    void handle(req, res, req.body);
  });

  // GET: server-initiated messages via SSE
  app.get("/mcp", (req: Request, res: Response) => {
    void handle(req, res);
  });

  // DELETE: session teardown
  app.delete("/mcp", (req: Request, res: Response) => {
    void handle(req, res);
  });

  // Health check
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  return app;
}

// Extracts the scope required for a `tools/call` request from the parsed
// JSON-RPC body. Other methods (initialize, tools/list, ping, ...) need only a
// valid token, so they map to no scope.
function requiredToolScope(req: Request): string | undefined {
  const body: unknown = req.body;
  if (!body || typeof body !== "object") {
    return undefined;
  }

  const message = body as { method?: unknown; params?: unknown };
  if (message.method !== "tools/call") {
    return undefined;
  }

  const params = message.params;
  if (!params || typeof params !== "object") {
    return undefined;
  }

  const name = (params as { name?: unknown }).name;
  return typeof name === "string" ? TOOL_SCOPES[name] : undefined;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const resourceUrl = process.env.MCP_RESOURCE_URL ?? `http://localhost:${port}/mcp`;
  const auth = mcpAuthSettingsFromEnv(process.env, resourceUrl);

  const apiToken = process.env.MCP_API_AUTH_TOKEN;
  const apiClientId = process.env.MCP_API_CLIENT_ID;
  const apiClientSecret = process.env.MCP_API_CLIENT_SECRET;
  // Downstream API calls target the WEB API audience (AUTH0_AUDIENCE), which is
  // distinct from this server's own MCP audience. The token endpoint lives on
  // the Auth0 issuer (which already carries a trailing slash).
  const apiAudience = authSettingsFromEnv().audience;
  const apiTokenUrl = `${auth.issuer}oauth/token`;
  const hasClientCredentials = Boolean(apiClientId && apiClientSecret);

  // When auth is required this server acts as an OAuth protected resource and
  // must authenticate to the API with its own service credential. Accept either
  // a runtime client-credentials pair (preferred — it auto-refreshes, so it
  // survives the ~24h Auth0 token lifetime) or a static MCP_API_AUTH_TOKEN. Fail
  // fast otherwise so a misconfigured deploy can't silently call the API
  // unauthenticated.
  if (auth.required && !apiToken && !hasClientCredentials) {
    logger.error(
      "A downstream API service credential is required when AUTH_REQUIRED=true: set " +
        "MCP_API_CLIENT_ID + MCP_API_CLIENT_SECRET (preferred, auto-refreshing) or a static MCP_API_AUTH_TOKEN."
    );
    process.exit(1);
  }

  const host = process.env.MCP_HTTP_HOST ?? "127.0.0.1";

  const app = createHttpMcpApp({
    auth,
    resourceUrl,
    apiToken,
    apiClientId,
    apiClientSecret,
    apiTokenUrl,
    apiAudience
  });

  app.listen(port, host, () => {
    logger.info(`markdown-magpie MCP (Streamable HTTP) listening on ${host}:${port}`);
  });
}

// Only start the server when run directly (e.g. `node dist/http.js`). Importing
// this module (tests) must not boot a listener or exit the process.
if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main().catch((err) => {
    logger.error({ err }, "MCP HTTP fatal");
    process.exit(1);
  });
}
