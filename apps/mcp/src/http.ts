import { argv } from "node:process";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { Express, NextFunction, Request, Response } from "express";
import {
  AuthError,
  authSettingsFromEnv,
  configuredIssuer,
  createApiTokenProvider,
  createRemoteAuthVerifier,
  hasScopes,
  parseBearerToken,
  providerProfile,
  type ApiTokenProvider,
  type AuthProvider,
  type AuthSettings,
  type Principal
} from "@magpie/auth";
import type { JSONWebKeySet } from "jose";
import { z } from "zod/v4";
import {
  approveQuestionnaire,
  approveSeedPlan,
  askQuestion,
  createQuestionnaire,
  generateOutline,
  getCitationSections,
  getJson,
  getQuestionnaire,
  listFlows,
  listKnowledgeChanges,
  submitFeedback,
  type KbClientOptions
} from "./kb-client.js";
import { createMcpLogger } from "./logger.js";

// ── Configuration ──────────────────────────────────────────────────────────

const port = parseInt(process.env.MCP_HTTP_PORT ?? "4001", 10);

const SCOPES_SUPPORTED = [
  "read:knowledge",
  "ask:knowledge",
  "feedback:questions",
  "manage:jobs",
  "manage:knowledge"
] as const;

// The user-level subset of SCOPES_SUPPORTED. Providers whose scopes are not per-user
// (Entra) ask clients to sign in with only these; see mcpSignInScopes.
const BASIC_SCOPES = ["read:knowledge", "ask:knowledge", "feedback:questions"] as const;

// Per-tool scope requirements enforced at the MCP boundary, mirroring the API
// route scopes. tools/list and other methods need only a valid token.
const TOOL_SCOPES: Record<string, string> = {
  kb_search: "read:knowledge",
  kb_flows: "read:knowledge",
  kb_ask: "ask:knowledge",
  kb_feedback: "feedback:questions",
  kb_outline: "manage:jobs",
  kb_seed: "manage:jobs",
  kb_citation: "read:knowledge",
  kb_changes: "read:knowledge",
  kb_questionnaire_create: "ask:knowledge",
  kb_questionnaire_get: "read:knowledge",
  kb_questionnaire_approve: "manage:knowledge"
};

// Resolves the auth settings the HTTP MCP server validates inbound tokens with.
//
// Critically, the MCP server has its OWN audience, distinct from the web API
// audience (AUTH_AUDIENCE / legacy AUTH0_AUDIENCE). MCP clients (Claude, Cursor, MCP Inspector) request
// a token using the RFC 8707 `resource` parameter set to the /mcp URL, so Auth0
// stamps `aud` = the /mcp URL. Validating those tokens against AUTH_AUDIENCE (the
// web API identifier) would reject every correctly-issued MCP token with a 401.
// The audience therefore comes from MCP_AUDIENCE, defaulting to the public /mcp
// resource URL. The web API (apps/api) is unchanged and still validates against
// AUTH_AUDIENCE (legacy AUTH0_AUDIENCE).
//
// Entra (AUTH_PROVIDER=entra) differs in three ways, all computed by the provider
// profile in @magpie/auth: a v2 token's `aud` is the MCP app's client-ID GUID, so
// MCP_AUDIENCE must be set explicitly (checked by mcpStartupIssues); the advertised
// authorization server is the versioned `.../oauth21/2026-08` identifier rather
// than the issuer; and advertised scopes are qualified with the MCP app's
// Application ID URI (MCP_API_ID_URI, default the resource URL). See docs/mcp.md.
export function mcpAuthSettingsFromEnv(env: NodeJS.ProcessEnv, resourceUrl: string): McpAuthSettings {
  const settings = authSettingsFromEnv(env);
  return {
    ...settings,
    audience: envValue(env.MCP_AUDIENCE) ?? resourceUrl,
    authorizationServer:
      envValue(env.MCP_AUTHORIZATION_SERVER) ??
      providerProfile(settings.provider).defaultMcpAuthorizationServer(settings.issuer),
    resourceIdUri: envValue(env.MCP_API_ID_URI) ?? resourceUrl
  };
}

// Provider-specific configuration problems that must stop the HTTP MCP server from
// starting. Only relevant when auth is required (with auth off nothing is verified
// or advertised to a client that would use it). Auth0 has none; Entra requires an
// explicit MCP_AUDIENCE and an Application-ID-URI-shaped MCP_RESOURCE_URL.
export function mcpStartupIssues(env: NodeJS.ProcessEnv, auth: McpAuthSettings, resourceUrl: string): string[] {
  if (!auth.required) {
    return [];
  }
  return providerProfile(auth.provider).mcpResourceIssues({
    resourceUrl,
    resourceIdUri: auth.resourceIdUri ?? resourceUrl,
    audienceConfigured: envValue(env.MCP_AUDIENCE) !== undefined,
    issuerConfigured: configuredIssuer(env) !== undefined
  });
}

// A blank `FOO=` line means unset.
function envValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

// The MCP server's inbound auth settings: the shared verifier settings plus what
// the protected-resource metadata advertises.
export interface McpAuthSettings extends AuthSettings {
  // The authorization server advertised in the protected-resource metadata
  // (MCP_AUTHORIZATION_SERVER). Defaults to the provider profile's value derived
  // from the issuer: the issuer itself for Auth0, `.../oauth21/2026-08` for Entra.
  authorizationServer?: string;
  // The MCP server's own Application ID URI (MCP_API_ID_URI), which Entra scopes
  // are qualified with in `scopes_supported` and challenges. Defaults to the
  // resource URL. Unused for Auth0.
  resourceIdUri?: string;
}

export interface HttpMcpOptions {
  auth: McpAuthSettings & { jwks?: () => Promise<JSONWebKeySet> };
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
  // Identity provider + (Entra only) API Application ID URI, which together
  // determine the client-credentials request shape (see @magpie/auth).
  apiAuthProvider?: AuthProvider;
  apiIdUri?: string;
}

// Carries the current request's verified user principal into the MCP tool handlers
// (which run deep inside transport.handleRequest and can't otherwise see the HTTP
// request), so the downstream API client can forward the user's identity for
// on-behalf-of delegation. Set per request in `handle`.
const requestContext = new AsyncLocalStorage<{ principal?: Principal }>();

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
    provider: options.apiAuthProvider,
    tokenUrl: options.apiTokenUrl,
    audience: options.apiAudience,
    apiIdUri: options.apiIdUri
  });
  // The downstream API is called with the MCP's own service token; when the
  // request carries a verified user, forward that user's identity so the API
  // authorizes as the user (on-behalf-of delegation). Falls back to plain service
  // identity when there is no user (auth disabled / non-user context).
  const kbOptions: KbClientOptions = {
    token: apiTokenProvider,
    onBehalfOf: () => {
      const principal = requestContext.getStore()?.principal;
      return principal ? { subject: principal.subject, roles: principal.roles ?? [] } : undefined;
    }
  };

  // Bind to loopback by default; require an explicit opt-in (e.g.
  // MCP_HTTP_HOST=0.0.0.0) to expose the server on all interfaces. Passing the
  // host to createMcpExpressApp also keeps DNS-rebinding protection enabled for
  // localhost binds.
  const host = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
  const app = createMcpExpressApp({ host });

  // Standard security headers on every response as defense-in-depth (the MCP
  // transport otherwise emits only the WWW-Authenticate challenge). Mirrors the
  // web API's secureHeaders. HSTS is only honoured by browsers over HTTPS, so it
  // is inert for plain-HTTP/loopback binds; production terminates TLS upstream.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
      "Referrer-Policy": "no-referrer",
      "Strict-Transport-Security": "max-age=15552000; includeSubDomains",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cross-Origin-Opener-Policy": "same-origin"
    });
    next();
  });

  // ── OAuth protected-resource metadata ─────────────────────────────────────
  // Scopes are advertised in the provider's form (Entra: fully qualified with the
  // MCP Application ID URI) while tokens are still checked against the short names.
  const profile = providerProfile(options.auth.provider);
  const resourceIdUri = options.auth.resourceIdUri ?? options.resourceUrl;
  const advertisedScopes = (scopes: readonly string[]): string[] =>
    scopes.map((scope) => profile.advertisedMcpScope(scope, resourceIdUri));
  const metadata = {
    resource: options.resourceUrl,
    authorization_servers: [
      options.auth.authorizationServer ?? profile.defaultMcpAuthorizationServer(options.auth.issuer)
    ],
    bearer_methods_supported: ["header"],
    scopes_supported: advertisedScopes(SCOPES_SUPPORTED)
  };

  // The discovery URL is derived from the resource origin so we never hardcode
  // the production host (RFC 9728 §3.1 anchors it at the resource's origin).
  const signInScopes = advertisedScopes(profile.mcpSignInScopes({ all: SCOPES_SUPPORTED, basic: BASIC_SCOPES }));

  const metadataUrl = `${new URL(options.resourceUrl).origin}/.well-known/oauth-protected-resource`;

  const serveMetadata = (_req: Request, res: Response): void => {
    res.json(metadata);
  };
  app.get("/.well-known/oauth-protected-resource", serveMetadata);
  app.get("/.well-known/oauth-protected-resource/mcp", serveMetadata);

  const verifier = options.auth.required ? createRemoteAuthVerifier(options.auth) : undefined;

  // 401: point the client at the metadata and name the scopes to request (the
  // same set and form as scopes_supported, so Auth0 clients that already fell back
  // to scopes_supported request exactly what they did before).
  function challenge(res: Response): void {
    res
      .status(401)
      .set("WWW-Authenticate", `Bearer resource_metadata="${metadataUrl}", scope="${signInScopes.join(" ")}"`)
      .json({ error: "unauthorized" });
  }

  // 403: RFC 6750 §3.1 insufficient_scope, so a client can step up its
  // authorization. The `scope` names the scopes the token already holds PLUS the
  // ones this request needs (in SCOPES_SUPPORTED order): a client re-authorizing
  // with only the missing scope would lose the ones it had and ping-pong.
  function insufficientScope(res: Response, principal: Principal, requiredScopes: readonly string[]): void {
    const stepUpScopes = SCOPES_SUPPORTED.filter(
      (scope) => principal.scopes.includes(scope) || requiredScopes.includes(scope)
    );
    res
      .status(403)
      .set(
        "WWW-Authenticate",
        `Bearer error="insufficient_scope", scope="${advertisedScopes(stepUpScopes).join(" ")}", resource_metadata="${metadataUrl}"`
      )
      .json({ error: "forbidden" });
  }

  // Validates the inbound token (when auth is required) and, for tools/call,
  // enforces the per-tool scope. On success returns the verified principal (or
  // undefined when auth is disabled) so the caller can forward the user identity
  // downstream; on failure it has already written the response.
  async function authorize(req: Request, res: Response): Promise<{ ok: true; principal?: Principal } | { ok: false }> {
    if (!verifier) {
      return { ok: true, principal: undefined };
    }

    let principal: Principal;
    try {
      principal = await verifier.verify(parseBearerToken(req.header("authorization")));
    } catch (error) {
      if (error instanceof AuthError) {
        challenge(res);
        return { ok: false };
      }
      throw error;
    }

    const requiredScopes = requiredToolScopes(req.body);
    if (requiredScopes.length > 0 && !hasScopes(principal, requiredScopes)) {
      insufficientScope(res, principal, requiredScopes);
      return { ok: false };
    }

    return { ok: true, principal };
  }

  const handle = async (req: Request, res: Response, body?: unknown): Promise<void> => {
    const startMs = Date.now();
    try {
      const authorized = await authorize(req, res);
      if (!authorized.ok) {
        logger.info(
          { method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - startMs },
          "request completed"
        );
        return;
      }
      // Stateless mode (no sessionIdGenerator). The SDK's stateless transport is
      // single-use — a second handleRequest throws — so every request gets its
      // own McpServer + transport pair. Closing the server also closes its
      // transport; do it once the response finishes or the client disconnects so
      // nothing outlives the request.
      const server = createMcpServer(kbOptions);
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        server.close().catch((closeErr: unknown) => {
          logger.warn({ err: closeErr, method: req.method, path: req.path }, "MCP transport close failed");
        });
      });
      await server.connect(transport);
      // Make the verified user available to the tool handlers so downstream API
      // calls can be made on behalf of this user.
      await requestContext.run({ principal: authorized.principal }, () => transport.handleRequest(req, res, body));
      logger.info(
        { method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - startMs },
        "request completed"
      );
    } catch (err) {
      // Never echo internal error text to the client; the real error is logged.
      if (!res.headersSent) {
        res.status(500).json({ error: "internal_error" });
      }
      logger.error(
        { err, method: req.method, path: req.path, status: 500, durationMs: Date.now() - startMs },
        "request error"
      );
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

// Builds an McpServer with every Magpie tool registered. Called once per HTTP
// request (the stateless transport is single-use); registration is cheap and the
// handlers share the app-level kbOptions (service token provider + on-behalf-of
// resolver reading the per-request principal from requestContext).
function createMcpServer(kbOptions: KbClientOptions): McpServer {
  const server = new McpServer({
    name: "markdown-magpie",
    version: "0.1.0"
  });

  server.registerTool(
    "kb_ask",
    {
      description:
        "Ask a question against the indexed Markdown knowledge base and return a cited answer. " +
        "By default (flow 'auto') the question is routed to the best-matching knowledge flow. " +
        "If routing cannot determine a flow, the result has flowSelectionRequired with the " +
        "available flows — call kb_ask again with `flow` set to one of those ids. Use kb_flows " +
        "to discover flows up front. For a multi-turn conversation, pass the `conversationId` " +
        "returned by the previous kb_ask: the answer then resolves against the prior turns and " +
        "stays in the same flow.",
      inputSchema: z.object({
        question: z.string().describe("The question to answer from indexed Markdown context."),
        flow: z
          .string()
          .optional()
          .describe(
            "Flow to answer within. Defaults to 'auto' (let the router decide). " +
              "Otherwise must be a flow id from kb_flows."
          ),
        conversationId: z
          .string()
          .optional()
          .describe(
            "Optional. The conversationId returned by a previous kb_ask, to ask a follow-up in " +
              "the same conversation. Omit to start a new conversation (a conversationId is returned)."
          )
      })
    },
    async ({ question, flow, conversationId }) => {
      const result = await askQuestion(question, kbOptions, flow, conversationId);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "kb_flows",
    {
      description:
        "List the knowledge flows a question can be routed to. Use the returned ids as the " +
        "`flow` argument to kb_ask.",
      inputSchema: z.object({})
    },
    async () => {
      const result = await listFlows(kbOptions);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "kb_search",
    {
      description: "Search indexed Markdown sections by keyword query.",
      inputSchema: z.object({
        query: z.string().describe("The search query."),
        limit: z.number().optional().describe("Maximum number of sections to return. Defaults to the API limit.")
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
    "kb_feedback",
    {
      description:
        "Report feedback on a previously asked question using the questionId returned by kb_ask. " +
        "kind is 'helpful', 'unhelpful', or 'knowledge_gap'. For 'knowledge_gap', optionally pass " +
        "gapSummary describing the missing knowledge.",
      inputSchema: z.object({
        questionId: z.string().describe("The questionId returned by kb_ask."),
        kind: z.enum(["helpful", "unhelpful", "knowledge_gap"]).describe("The kind of feedback to record."),
        gapSummary: z
          .string()
          .optional()
          .describe("Optional summary of the missing knowledge. Only used when kind is 'knowledge_gap'.")
      })
    },
    async (args) => {
      const result = await submitFeedback(args, kbOptions);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "kb_outline",
    {
      description:
        "Propose a seed plan for a flow by exploring its source repositories — no topic needed. Returns the " +
        "persisted plan (documents + proposed charter) for review; nothing is drafted. Approve with kb_seed, " +
        "or review/edit in the console. Discover flow ids with kb_flows.",
      inputSchema: z.object({
        flow: z.string().describe("The flow id to plan for (from kb_flows)."),
        notes: z
          .string()
          .optional()
          .describe("Optional guidance to steer this planning run (emphasis, exclusions, audience).")
      })
    },
    async (args) => {
      const result = await generateOutline(args, kbOptions);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "kb_seed",
    {
      description:
        "Approve a seed plan (from kb_outline or the console): drafts one document per approved item straight " +
        "into the proposal → pull-request pipeline. Edit or partially dismiss items in the console first if needed.",
      inputSchema: z.object({
        plan: z.string().describe("The seed plan id to approve (from kb_outline's planId, or the console).")
      })
    },
    async (args) => {
      const result = await approveSeedPlan(args, kbOptions);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "kb_citation",
    {
      description:
        "Fetch the full content of cited knowledge-base sections so the evidence behind an answer can be " +
        "shown. Pass the sectionId values from kb_ask citations (or kb_search results). Returns the currently " +
        "indexed version of each section plus a `missing` list for ids that no longer exist (the knowledge " +
        "base changed since the answer — re-ask or use kb_search).",
      inputSchema: z.object({
        sectionIds: z
          .array(z.string())
          .min(1)
          .max(20)
          .describe("The sectionId values to resolve, from kb_ask citations or kb_search results.")
      })
    },
    async (args) => {
      const result = await getCitationSections(args, kbOptions);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "kb_questionnaire_create",
    {
      description:
        "Create a questionnaire — a named batch of questions answered against one flow's knowledge base, with " +
        "verbatim reuse of previously approved answers when the knowledge base hasn't changed. Returns " +
        "immediately; items may still be answering — re-read with kb_questionnaire_get until no items are " +
        "pending/answering. Discover flow ids with kb_flows.",
      inputSchema: z.object({
        name: z.string().describe("Human-readable questionnaire name (e.g. 'Q3 vendor security review')."),
        flow: z.string().describe("The flow id whose knowledge base answers the batch (from kb_flows)."),
        questions: z.array(z.string()).min(1).max(500).describe("The questions to answer, one per entry (1-500).")
      })
    },
    async (args) => {
      const result = await createQuestionnaire(args, kbOptions);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "kb_questionnaire_get",
    {
      description:
        "Read a questionnaire worksheet: per-item status (reused/fresh/changed/unanswerable), answers, " +
        "citations, and change explanations. Re-read until no items are pending/answering.",
      inputSchema: z.object({
        questionnaire: z.string().describe("The questionnaire id (from kb_questionnaire_create).")
      })
    },
    async (args) => {
      const result = await getQuestionnaire(args, kbOptions);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "kb_questionnaire_approve",
    {
      description:
        "Approve answers into the match corpus for future questionnaires: all reused items (default) or one " +
        "item by id. Approval is what makes an answer reusable verbatim next time.",
      inputSchema: z.object({
        questionnaire: z.string().describe("The questionnaire id (from kb_questionnaire_create)."),
        item: z
          .string()
          .optional()
          .describe("Optional item id to approve one answered item instead of all reused items.")
      })
    },
    async (args) => {
      const result = await approveQuestionnaire(args, kbOptions);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "kb_changes",
    {
      description:
        "List what changed in a flow's knowledge base since a given date — the change log, not a search. " +
        'This is the tool for "what\'s new this week in <product>": a filtered list of added/removed/changed ' +
        "documents and sections, each with when it changed and what caused it (gap | source_sync | patrol | " +
        "seed | external), returned directly. The summary carries counts by kind and cause, the distinct " +
        "documents touched, and logStartedAt — the first instant the log recorded for this flow; when it is " +
        "absent nothing has EVER been recorded (the log starts at install and is never backfilled), so an " +
        'empty result means "nothing recorded yet", not "nothing changed". Where an entry names an upstream ' +
        "commit range it also carries upstream.changedFileCount (files the range truly touched) and " +
        "upstream.examinedFileCount (how many the sync run examined) — report both, never just the second. " +
        "Discover flow ids with kb_flows.",
      inputSchema: z.object({
        flowId: z.string().describe("The flow whose knowledge base to report changes for (from kb_flows)."),
        since: z
          .string()
          .describe("Only changes at or after this instant, e.g. '2026-08-20' or '2026-08-20T00:00:00Z'."),
        documentPath: z
          .string()
          .optional()
          .describe(
            "Optional. One document's timeline instead of the whole flow. A repository-relative path as shown " +
              "on an entry's `path` (e.g. 'billing/rates.md'), not a `<repositoryId>:<path>` document id — it " +
              "is resolved against the flow's destination repository, so a document that has since been removed " +
              "still resolves. A path with no history in the flow is an error, not an empty list."
          )
      })
    },
    async (args) => {
      const result = await listKnowledgeChanges(args, kbOptions);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  return server;
}

// Computes the scopes a parsed JSON-RPC body requires. A body may be a single
// message OR a JSON-RPC batch (array) — the SDK dispatches every element of a
// batch, so we must inspect each one and require the UNION of their per-tool
// scopes (a token missing any is rejected). Other methods (initialize,
// tools/list, ping, ...) need only a valid token, so they contribute no scope.
// Returning the union to `hasScopes` (which requires all) enforces the strictest
// combination across the batch. Single-object bodies are the one-element case.
function requiredToolScopes(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body];
  const scopes = new Set<string>();
  for (const message of messages) {
    const scope = toolScopeForMessage(message);
    if (scope) {
      scopes.add(scope);
    }
  }
  return [...scopes];
}

// Extracts the per-tool scope required by a single JSON-RPC message, or
// undefined when the message is not a scoped `tools/call`.
function toolScopeForMessage(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  const { method, params } = message as { method?: unknown; params?: unknown };
  if (method !== "tools/call" || !params || typeof params !== "object") {
    return undefined;
  }

  const name = (params as { name?: unknown }).name;
  return typeof name === "string" ? TOOL_SCOPES[name] : undefined;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const resourceUrl = envValue(process.env.MCP_RESOURCE_URL) ?? `http://localhost:${port}/mcp`;
  const auth = mcpAuthSettingsFromEnv(process.env, resourceUrl);
  const startupIssues = mcpStartupIssues(process.env, auth, resourceUrl);
  if (startupIssues.length > 0) {
    logger.error(`Invalid MCP auth configuration:\n- ${startupIssues.join("\n- ")}`);
    process.exit(1);
  }

  const apiToken = process.env.MCP_API_AUTH_TOKEN;
  const apiClientId = process.env.MCP_API_CLIENT_ID;
  const apiClientSecret = process.env.MCP_API_CLIENT_SECRET;
  // Downstream API calls target the WEB API audience (AUTH_AUDIENCE, legacy
  // AUTH0_AUDIENCE), which is distinct from this server's own MCP audience. The
  // provider, token endpoint (AUTH_TOKEN_URL or the provider default) and — for
  // Entra — the API ID URI come from the same settings the API validates against.
  const apiSettings = authSettingsFromEnv();
  const apiAudience = apiSettings.audience;
  const apiTokenUrl = apiSettings.tokenUrl;
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
    apiAudience,
    apiAuthProvider: apiSettings.provider,
    apiIdUri: apiSettings.apiIdUri
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
