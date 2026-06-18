# Auth0 MCP Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate the Markdown Magpie UI, API, and MCP server with Auth0 while preserving local unauthenticated development when `AUTH_REQUIRED` is unset.

**Architecture:** Add one shared `@magpie/auth` package for Auth0 JWT validation and scope checks, then adapt it in the Hono API and Express MCP HTTP server. The web app obtains Auth0 access tokens with PKCE and attaches them to API calls; the HTTP MCP server validates inbound user tokens, enforces tool scopes, and calls the API with a separate service token.

**Tech Stack:** TypeScript, Node 22, Hono, Express, Next.js, React, Auth0 React SDK, `jose`, Node test runner.

---

## Progress Snapshot

**Updated:** 2026-06-18

**Workspace:** implementation is happening in the isolated worktree
`/home/adam/markdown-magpie/.worktrees/auth0-mcp-gating` on branch
`auth0-mcp-gating`.

**Completed and reviewed:**

- Task 1 Shared Auth Package — complete, passed both review gates.
  - `9733574 feat(auth): add shared auth0 verifier`
  - `1e79ce7 fix(auth): tighten verifier review findings`
- Task 2 API Auth Middleware and Route Scopes — complete, passed both review gates.
  - `17b9152 feat(api): gate routes with auth0 scopes`
  - `c067f7e fix(api): read auth settings from environment`
  - `6cfb7d2 fix(api): drop context casts and dead auth branch`
  - Spec review: ✅ all routes carry explicit scopes, error contract correct,
    runtime honors `AUTH_REQUIRED` from `process.env`.
  - Code quality review: two Important findings fixed in `6cfb7d2` (removed
    `as unknown` double-casts via Hono `ContextVariableMap`; rethrow non-`AuthError`
    instead of a dead catch branch). Re-review: ✅ approved.
  - Verified: `npm run test -w @magpie/api -- src/app.test.ts` → 124 pass / 0 fail.
- Task 3 Web Auth0 Login and API Token Injection — complete, passed both review gates.
  - `7a7d7c5 feat(web): add auth0 login and api tokens`
  - Spec review: ✅ disabled-auth path is byte-identical to today; `AuthActions`
    only mounts when auth is configured (guarded via `authConfiguredFromWindow()`,
    same `domain && clientId && audience` predicate as `AuthProvider`).
  - Code quality review: ✅ ready to merge. No banned casts/`any`; `Window`
    augmentation is a proper `declare global` merge; token fetch is lazy per-request.
  - Verified: `npm run typecheck -w @magpie/web` passes.

**Follow-up to decide alongside Task 4:** if `getAccessTokenSilently()` rejects
(expired session / refresh hiccup), `authHeaders` currently rejects the whole API
call rather than degrading to a re-auth prompt. Acceptable for now (API will 401
anyway once MCP/API rejection lands), but Task 4 should settle the agreed UX so both
halves match.

- Task 4 HTTP MCP Authorization — complete, passed both review gates.
  - `9e8f685 feat(mcp): protect http transport with auth0`
  - `fee9330 test(mcp): cover authorized tool dispatch and downstream service token`
  - `3572eae docs(mcp): explain lazy transport connect`
  - Spec review: all 9 functional requirements met (metadata on both well-known
    paths, 401+`WWW-Authenticate` with origin-derived URL, GET/POST/DELETE gated,
    per-tool scopes, `MCP_API_AUTH_TOKEN` downstream with no user-token forwarding,
    `MCP_API_AUTH_TOKEN` startup fail-fast). Two design-mandated tests were missing
    (authorized tool dispatch + downstream service-token) and were added in
    `fee9330`; re-review: ✅ gap closed.
  - Code quality review: ✅ ready to merge; no banned casts/`any`, verifier built
    once, 401/403 clean, auth-disabled path byte-identical. Lazy-connect comment
    added in `3572eae`.
  - Verified: `npm run test -w @magpie/mcp` → 11 pass / 0 fail; `typecheck` clean.
- Task 5 stdio MCP Token Handling — complete, passed both review gates.
  - `e15f935 feat(mcp): pass auth tokens from stdio`
  - `b7f315e test(mcp): make stdio entrypoint importable and test auth guard`
  - Spec review: stdio passes `MCP_AUTH_TOKEN` (not `MCP_API_AUTH_TOKEN`) to all API
    calls; startup fails fast (stderr + exit 1) when `AUTH_REQUIRED=true` and token
    missing; disabled path byte-identical. kb-client `{ token }` plumbing reused from
    Task 4 (unchanged). The design-mandated startup-rejection test was initially
    missing because `main.ts` ran side effects at import; closed in `b7f315e` by
    adding the `http.ts`-style `fileURLToPath(import.meta.url) === argv[1]` entrypoint
    guard so the pure `resolveStdioAuthToken` helper is unit-testable. Re-review: ✅.
  - Code quality review: ✅ ready to merge; clean import/runtime split mirroring
    `http.ts`, pure tested guard helper, no banned casts/`any`.
  - Verified: `npm run test -w @magpie/mcp` → 16 pass / 0 fail (no hang); `typecheck`
    clean.
- Task 6 Env and Docs — complete, passed both review gates.
  - `a7d27da docs: document auth0 configuration`
  - `4b3892a docs: fix mcp design link and clarify auth docs`
  - Updated `.env.example`, `.env.compose.example`, `README.md`, `docs/mcp.md`.
  - Spec review: ✅ all required Auth0 env vars/sections present; every documented
    var verified against an actual code reference; per-tool scope table matches
    `TOOL_SCOPES`. Incidental fix: corrected an existing `MCP_HTTP_HOST` doc default
    (`0.0.0.0`→`127.0.0.1`) to match code.
  - Docs quality review found a broken design-doc link (404) + minor polish; fixed
    in `4b3892a` (corrected relative link, disambiguated the two auth sections,
    clarified the JWKS default URL). Re-review: ✅ fixes confirmed.

**In progress:**
- Task 7 Full Verification.

**Known note:** `npm run typecheck -w @magpie/api` reports pre-existing package-local
`rootDir` (TS6059) errors for sibling workspace imports, present on clean HEAD and
unrelated to the auth work. Tests run via `tsx` (the canonical test path) and pass;
root `npm run typecheck` is the relevant repo-level check.

---

## File Structure

- Create `packages/auth`: shared Auth0 config, JWKS-backed JWT validation, bearer parsing, scope helpers, and tests.
- Modify `apps/api/src/app.ts`: make `/api/health` public, require auth for all other `/api` routes when enabled.
- Create `apps/api/src/auth/middleware.ts`: Hono auth and scope middleware built on `@magpie/auth`.
- Modify API route files under `apps/api/src/features/*/routes.ts`: add explicit route-level scope middleware.
- Modify `apps/web/src/app/layout.tsx`: provide Auth0 runtime config to client code.
- Create `apps/web/src/components/AuthProvider.tsx`: browser-only Auth0 provider wrapper.
- Modify `apps/web/src/components/AppShell.tsx`: add compact login/logout identity controls.
- Modify `apps/web/src/lib/api.ts`: attach access tokens when auth is configured.
- Modify `apps/mcp/src/http.ts`: add protected-resource metadata, `WWW-Authenticate`, JWT validation, and scope checks.
- Modify `apps/mcp/src/main.ts`: fail fast when stdio auth is required and `MCP_AUTH_TOKEN` is missing.
- Modify `apps/mcp/src/kb-client.ts`: add optional bearer token support for all API calls.
- Update `.env.example`, `.env.compose.example`, `README.md`, and `docs/mcp.md`.

## Task 1: Shared Auth Package

**Files:**
- Create: `packages/auth/package.json`
- Create: `packages/auth/tsconfig.json`
- Create: `packages/auth/tsconfig.build.json`
- Create: `packages/auth/src/index.ts`
- Create: `packages/auth/src/index.test.ts`
- Modify: `package.json`

- [x] **Step 1: Create package manifest and add dependencies**

Create `packages/auth/package.json`:

```json
{
  "name": "@magpie/auth",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "test": "node --import tsx --test \"src/**/*.test.ts\"",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {},
  "devDependencies": {
    "@types/node": "^25.9.3",
    "tsx": "^4.22.4",
    "typescript": "^6.0.3"
  }
}
```

Run:

```bash
npm install jose -w @magpie/auth
npm install @auth0/auth0-react -w @magpie/web
```

Expected: `package-lock.json`, `packages/auth/package.json`, and `apps/web/package.json` update.

- [x] **Step 2: Create a failing auth package test**

Create `packages/auth/src/index.test.ts`:

```ts
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRemoteAuthVerifier, hasScopes, parseBearerToken } from "./index.js";

const issuer = "https://example.auth0.com/";
const audience = "https://markdown-magpie.local/api";

async function signedToken(scope: string, overrides: Record<string, unknown> = {}): Promise<{ token: string; jwks: JsonWebKeySet }> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const kid = "test-key";
  const token = await new SignJWT({ scope, ...overrides })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject("auth0|user")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  return { token, jwks: { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] } };
}

test("parseBearerToken extracts a bearer token", () => {
  assert.equal(parseBearerToken("Bearer abc.def.ghi"), "abc.def.ghi");
  assert.equal(parseBearerToken("Basic abc"), undefined);
});

test("createRemoteAuthVerifier accepts a valid scoped RS256 token", async () => {
  const { token, jwks } = await signedToken("read:knowledge ask:knowledge");
  const verifier = createRemoteAuthVerifier({
    required: true,
    issuer,
    audience,
    jwks: async () => jwks
  });

  const principal = await verifier.verify(token);

  assert.equal(principal.subject, "auth0|user");
  assert.deepEqual(principal.scopes, ["read:knowledge", "ask:knowledge"]);
  assert.equal(hasScopes(principal, ["ask:knowledge"]), true);
  assert.equal(hasScopes(principal, ["manage:admin"]), false);
});

test("createRemoteAuthVerifier rejects the wrong audience", async () => {
  const { token, jwks } = await signedToken("read:knowledge", { aud: "wrong" });
  const verifier = createRemoteAuthVerifier({
    required: true,
    issuer,
    audience,
    jwks: async () => jwks
  });

  await assert.rejects(() => verifier.verify(token), /invalid_token/);
});
```

- [x] **Step 3: Verify the test fails**

Run:

```bash
npm run test -w @magpie/auth
```

Expected: FAIL because `@magpie/auth` and its exports do not exist yet.

- [x] **Step 4: Implement the shared package**

Create `packages/auth/tsconfig.json` and `packages/auth/tsconfig.build.json` using the same pattern as `packages/core`.

Create `packages/auth/src/index.ts` with:

```ts
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export interface AuthSettings {
  required: boolean;
  issuer: string;
  audience: string;
  jwksUri?: string;
}

export interface Principal {
  subject: string;
  scopes: string[];
  payload: JWTPayload;
}

export class AuthError extends Error {
  constructor(
    public readonly code: "missing_token" | "invalid_token" | "forbidden",
    message = code
  ) {
    super(message);
  }
}

export function authSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): AuthSettings {
  const issuer = trimTrailingSlash(env.AUTH0_ISSUER_BASE_URL ?? `https://${env.AUTH0_DOMAIN ?? ""}`) + "/";
  return {
    required: env.AUTH_REQUIRED === "true",
    issuer,
    audience: env.AUTH0_AUDIENCE ?? "https://markdown-magpie.local/api",
    jwksUri: env.AUTH0_JWKS_URI
  };
}

export function parseBearerToken(header: string | undefined | null): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return match?.[1];
}

export function hasScopes(principal: Principal, requiredScopes: readonly string[]): boolean {
  return requiredScopes.every((scope) => principal.scopes.includes(scope));
}

export function createRemoteAuthVerifier(options: AuthSettings & { jwks?: () => Promise<JsonWebKeySet> }) {
  const remoteJwks = options.jwks ? undefined : createRemoteJWKSet(new URL(options.jwksUri ?? `${options.issuer}.well-known/jwks.json`));

  return {
    async verify(token: string | undefined): Promise<Principal> {
      if (!token) {
        throw new AuthError("missing_token");
      }

      try {
        const keySet = options.jwks ? createLocalJWKSet(await options.jwks()) : remoteJwks;
        const { payload } = await jwtVerify(token, keySet, {
          issuer: options.issuer,
          audience: options.audience,
          algorithms: ["RS256"]
        });
        return {
          subject: payload.sub ?? "",
          scopes: typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : [],
          payload
        };
      } catch (error) {
        if (error instanceof AuthError) {
          throw error;
        }
        throw new AuthError("invalid_token");
      }
    }
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
```

- [x] **Step 5: Run package tests**

Run:

```bash
npm run test -w @magpie/auth
```

Expected: PASS.

- [x] **Step 6: Add auth package to root build**

Modify root `package.json` build script so `npm run build -w @magpie/auth` runs before `@magpie/api` and `@magpie/mcp`.

- [x] **Step 7: Commit**

```bash
git add package.json package-lock.json packages/auth apps/web/package.json
git commit -m "feat(auth): add shared auth0 verifier"
```

## Task 2: API Auth Middleware and Route Scopes

**Files:**
- Create: `apps/api/src/auth/middleware.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/features/*/routes.ts`
- Test: `apps/api/src/app.test.ts`

- [x] **Step 1: Write failing API tests**

Append to `apps/api/src/app.test.ts`:

```ts
test("auth required keeps /api/health public and protects other routes", async () => {
  const app = buildApp(makeTestContext(), {
    auth: { required: true, issuer: "https://example.auth0.com/", audience: "https://markdown-magpie.local/api" }
  });

  assert.equal((await app.request("/api/health")).status, 200);
  assert.equal((await app.request("/api/knowledge/stats")).status, 401);
});

test("auth required rejects valid tokens without the route scope", async () => {
  const token = await testJwt({ scope: "ask:knowledge" });
  const app = buildApp(makeTestContext(), testAuthOptions());

  const res = await app.request("/api/knowledge/stats", { headers: { authorization: `Bearer ${token}` } });

  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "forbidden" });
});

test("auth required allows valid tokens with the route scope", async () => {
  const token = await testJwt({ scope: "read:knowledge" });
  const app = buildApp(makeTestContext(), testAuthOptions());

  const res = await app.request("/api/knowledge/stats", { headers: { authorization: `Bearer ${token}` } });

  assert.equal(res.status, 200);
});
```

Add local helpers in the test file using `jose` test keys, matching Task 1.

- [x] **Step 2: Verify the API tests fail**

Run:

```bash
npm run test -w @magpie/api -- src/app.test.ts
```

Expected: FAIL because `buildApp` does not accept test auth options and routes are not protected.

- [x] **Step 3: Implement Hono middleware**

Create `apps/api/src/auth/middleware.ts`:

```ts
import type { Context, MiddlewareHandler } from "hono";
import { AuthError, authSettingsFromEnv, createRemoteAuthVerifier, hasScopes, parseBearerToken, type AuthSettings, type Principal } from "@magpie/auth";

export interface ApiAuthOptions {
  auth?: AuthSettings & { jwks?: () => Promise<JsonWebKeySet> };
}

type AuthVariables = {
  principal?: Principal;
};

export function requireAuth(options: ApiAuthOptions = {}): MiddlewareHandler<{ Variables: AuthVariables }> {
  const settings = options.auth ?? authSettingsFromEnv();
  const verifier = createRemoteAuthVerifier(settings);
  return async (c, next) => {
    if (!settings.required) {
      return next();
    }

    try {
      const principal = await verifier.verify(parseBearerToken(c.req.header("authorization")));
      c.set("principal", principal);
      return next();
    } catch {
      return c.json({ error: "unauthorized" }, 401);
    }
  };
}

export function requireScopes(...scopes: string[]): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c: Context<{ Variables: AuthVariables }>, next) => {
    const principal = c.get("principal");
    if (!principal) {
      return next();
    }
    if (!hasScopes(principal, scopes)) {
      return c.json({ error: "forbidden" }, 403);
    }
    return next();
  };
}
```

- [x] **Step 4: Wire app-level auth**

Change `buildApp(ctx: AppContext)` to `buildApp(ctx: AppContext, options: ApiAuthOptions = {})`. In `apps/api/src/app.ts`, call `api.get("/health", ...)` first, then `api.use("*", requireAuth(options))`, then mount feature routes.

- [x] **Step 5: Add route scopes**

Import `requireScopes` into feature route files and add middleware:

- `askRoutes`: `app.post("/", requireScopes("ask:knowledge"), ...)`
- `knowledgeRoutes`: GET routes use `read:knowledge`; `/repositories/index` uses `manage:knowledge`.
- `questionRoutes`: list/read use `read:knowledge`; feedback uses `feedback:questions`.
- `gapRoutes`: read routes use `read:knowledge`; actions use `manage:knowledge`.
- `proposalRoutes`, `crunchRoutes`, `scheduledTaskRoutes`, `jobRoutes`: use matching `manage:*` scopes from the spec.
- `promptRoutes`: use `read:knowledge`.
- `configRoutes` and `adminRoutes`: use `manage:admin`.

- [x] **Step 6: Run API tests**

Run:

```bash
npm run test -w @magpie/api -- src/app.test.ts
```

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add apps/api packages/auth package.json package-lock.json
git commit -m "feat(api): gate routes with auth0 scopes"
```

## Task 3: Web Auth0 Login and API Token Injection

**Files:**
- Create: `apps/web/src/components/AuthProvider.tsx`
- Modify: `apps/web/src/app/layout.tsx`
- Modify: `apps/web/src/components/AppShell.tsx`
- Modify: `apps/web/src/lib/api.ts`

- [x] **Step 1: Write the failing typecheck target**

Run:

```bash
npm run typecheck -w @magpie/web
```

Expected before edits: PASS. After adding the imports in Step 2 before the provider exists, it should fail.

- [x] **Step 2: Add the intended provider usage**

Modify `apps/web/src/app/layout.tsx` to wrap `ConsoleProvider` with `<AuthProvider config={runtimeConfig.auth}>`. Extend the injected runtime config with:

```ts
auth: {
  domain: process.env.NEXT_PUBLIC_AUTH0_DOMAIN || "",
  clientId: process.env.NEXT_PUBLIC_AUTH0_CLIENT_ID || "",
  audience: process.env.NEXT_PUBLIC_AUTH0_AUDIENCE || process.env.AUTH0_AUDIENCE || "",
  redirectUri: process.env.NEXT_PUBLIC_AUTH0_REDIRECT_URI || "http://localhost:3000"
}
```

- [x] **Step 3: Verify typecheck fails**

Run:

```bash
npm run typecheck -w @magpie/web
```

Expected: FAIL because `AuthProvider` is not implemented.

- [x] **Step 4: Implement `AuthProvider`**

Create `apps/web/src/components/AuthProvider.tsx`:

```tsx
"use client";

import { Auth0Provider, useAuth0 } from "@auth0/auth0-react";
import { ReactNode, useEffect } from "react";
import { setAccessTokenProvider } from "../lib/api";

export interface BrowserAuthConfig {
  domain: string;
  clientId: string;
  audience: string;
  redirectUri: string;
}

export function AuthProvider({ children, config }: { children: ReactNode; config: BrowserAuthConfig }) {
  const enabled = Boolean(config.domain && config.clientId && config.audience);
  if (!enabled) {
    return children;
  }
  return (
    <Auth0Provider
      domain={config.domain}
      clientId={config.clientId}
      authorizationParams={{ audience: config.audience, redirect_uri: config.redirectUri }}
      cacheLocation="localstorage"
      useRefreshTokens
    >
      <AuthTokenBridge>{children}</AuthTokenBridge>
    </Auth0Provider>
  );
}

function AuthTokenBridge({ children }: { children: ReactNode }) {
  const { getAccessTokenSilently, isAuthenticated } = useAuth0();
  useEffect(() => {
    setAccessTokenProvider(isAuthenticated ? () => getAccessTokenSilently() : undefined);
    return () => setAccessTokenProvider(undefined);
  }, [getAccessTokenSilently, isAuthenticated]);
  return children;
}
```

- [x] **Step 5: Update API token injection**

In `apps/web/src/lib/api.ts`, add:

```ts
let accessTokenProvider: (() => Promise<string>) | undefined;

export function setAccessTokenProvider(provider: (() => Promise<string>) | undefined): void {
  accessTokenProvider = provider;
}

async function authHeaders(headers: Record<string, string> = {}): Promise<Record<string, string>> {
  if (!accessTokenProvider) {
    return headers;
  }
  const token = await accessTokenProvider();
  return { ...headers, authorization: `Bearer ${token}` };
}
```

Use `await authHeaders()` in `apiGet`, `apiPost`, and `apiDelete`.

- [x] **Step 6: Add identity controls**

In `apps/web/src/components/AppShell.tsx`, use `useAuth0` only inside a small child component so the app still renders when auth is disabled:

```tsx
function AuthActions() {
  const { isAuthenticated, isLoading, user, loginWithRedirect, logout } = useAuth0();
  if (isLoading) return <span className="refreshTime">Checking session</span>;
  if (!isAuthenticated) return <button className="button secondary" onClick={() => void loginWithRedirect()} type="button">Log in</button>;
  return (
    <>
      <span className="refreshTime">{user?.email ?? user?.name ?? "Signed in"}</span>
      <button className="button secondary" onClick={() => logout({ logoutParams: { returnTo: window.location.origin } })} type="button">Log out</button>
    </>
  );
}
```

Render it in `.topActions`.

- [x] **Step 7: Run web typecheck**

Run:

```bash
npm run typecheck -w @magpie/web
```

Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add apps/web package-lock.json apps/web/package.json
git commit -m "feat(web): add auth0 login and api tokens"
```

## Task 4: HTTP MCP Authorization

**Files:**
- Modify: `apps/mcp/src/http.ts`
- Modify: `apps/mcp/src/kb-client.ts`
- Create: `apps/mcp/src/http.test.ts`

- [x] **Step 1: Write failing HTTP MCP tests**

Create `apps/mcp/src/http.test.ts` with tests for:

```ts
test("protected-resource metadata exposes the auth0 issuer", async () => {
  const app = createHttpMcpApp({ auth: { required: true, issuer: "https://example.auth0.com/", audience: "https://markdown-magpie.local/api" }, resourceUrl: "https://mcp-magpie.wastedcake.com/mcp", apiToken: "service-token" });
  const res = await request(app).get("/.well-known/oauth-protected-resource");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.authorization_servers, ["https://example.auth0.com/"]);
});

test("/mcp without a bearer token returns a discovery challenge", async () => {
  const app = createHttpMcpApp(testOptions());
  const res = await request(app).post("/mcp").send({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal(res.status, 401);
  assert.match(res.header["www-authenticate"], /resource_metadata=/);
});
```

Use the existing Express app directly; if `supertest` is not present, use `node:http` and `app.listen(0)` in the test helper.

- [x] **Step 2: Verify HTTP MCP tests fail**

Run:

```bash
npm run test -w @magpie/mcp
```

Expected: FAIL because the app is not exported and auth is not implemented.

- [x] **Step 3: Extract app factory**

Refactor `apps/mcp/src/http.ts` so `main()` calls an exported `createHttpMcpApp(options)` and then listens. Preserve current runtime behaviour when auth is disabled.

- [x] **Step 4: Add metadata and challenge**

Implement:

```ts
const metadata = {
  resource: options.resourceUrl,
  authorization_servers: [options.auth.issuer],
  bearer_methods_supported: ["header"],
  scopes_supported: ["read:knowledge", "ask:knowledge", "feedback:questions"]
};
```

Serve it from both well-known paths. Return `WWW-Authenticate: Bearer resource_metadata="https://mcp-magpie.wastedcake.com/.well-known/oauth-protected-resource"` for missing/invalid tokens.

- [x] **Step 5: Enforce MCP scopes**

Before dispatching `/mcp`, verify the inbound token. For `tools/call`, check:

- `kb.search` => `read:knowledge`
- `kb.ask` => `ask:knowledge`
- `kb.feedback` => `feedback:questions`

Use `MCP_API_AUTH_TOKEN` for calls to `askQuestion`, `getJson`, and `submitFeedback`.

- [x] **Step 6: Run MCP tests**

Run:

```bash
npm run test -w @magpie/mcp
```

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add apps/mcp packages/auth package-lock.json apps/mcp/package.json
git commit -m "feat(mcp): protect http transport with auth0"
```

## Task 5: stdio MCP Token Handling

**Files:**
- Modify: `apps/mcp/src/main.ts`
- Modify: `apps/mcp/src/kb-client.ts`
- Test: `apps/mcp/src/kb-client.test.ts`

- [x] **Step 1: Write failing client token test**

Create `apps/mcp/src/kb-client.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { getJson } from "./kb-client.js";

test("getJson sends the configured bearer token", async () => {
  const calls: HeadersInit[] = [];
  globalThis.fetch = async (_url, init) => {
    calls.push(init?.headers ?? {});
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  await getJson("/health", { token: "stdio-token" });

  assert.deepEqual(calls[0], { authorization: "Bearer stdio-token" });
});
```

- [x] **Step 2: Verify MCP client test fails**

Run:

```bash
npm run test -w @magpie/mcp -- src/kb-client.test.ts
```

Expected: FAIL because `getJson` does not accept token options.

- [x] **Step 3: Implement token options**

Update `getJson`, `postJson`, `askQuestion`, and `submitFeedback` to accept `{ token?: string }`, set `authorization` when present, and pass options through queued answer polling.

- [x] **Step 4: Add stdio startup guard**

In `apps/mcp/src/main.ts`, read:

```ts
const authRequired = process.env.AUTH_REQUIRED === "true";
const stdioAuthToken = process.env.MCP_AUTH_TOKEN;
if (authRequired && !stdioAuthToken) {
  console.error("MCP_AUTH_TOKEN is required when AUTH_REQUIRED=true for stdio MCP.");
  process.exit(1);
}
```

Pass `stdioAuthToken` into every `askQuestion`, `getJson`, and `submitFeedback` call.

- [x] **Step 5: Run MCP tests**

Run:

```bash
npm run test -w @magpie/mcp
```

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add apps/mcp
git commit -m "feat(mcp): pass auth tokens from stdio"
```

## Task 6: Env and Docs

**Files:**
- Modify: `.env.example`
- Modify: `.env.compose.example`
- Modify: `README.md`
- Modify: `docs/mcp.md`

- [x] **Step 1: Update env templates**

Add an `Auth0` section with:

```dotenv
AUTH_REQUIRED=false
AUTH0_DOMAIN=
AUTH0_ISSUER_BASE_URL=
AUTH0_AUDIENCE=https://markdown-magpie.local/api
NEXT_PUBLIC_AUTH0_DOMAIN=
NEXT_PUBLIC_AUTH0_CLIENT_ID=
NEXT_PUBLIC_AUTH0_AUDIENCE=https://markdown-magpie.local/api
NEXT_PUBLIC_AUTH0_REDIRECT_URI=http://localhost:3000
MCP_RESOURCE_URL=http://localhost:4001/mcp
MCP_AUTH_TOKEN=
MCP_API_AUTH_TOKEN=
```

In compose, document production values:

```dotenv
NEXT_PUBLIC_AUTH0_REDIRECT_URI=https://magpie.wastedcake.com
MCP_RESOURCE_URL=https://mcp-magpie.wastedcake.com/mcp
```

- [x] **Step 2: Update README**

Add a concise Auth0 checklist:

```md
## Auth0

Create an Auth0 SPA for `https://magpie.wastedcake.com` and `http://localhost:3000`.
Create an Auth0 API with audience `https://markdown-magpie.local/api` and scopes listed in `docs/superpowers/specs/2026-06-18-auth0-mcp-gating-design.md`.
Create a machine-to-machine application for the HTTP MCP server and put its access token in `MCP_API_AUTH_TOKEN`.
The official Auth0 MCP server can bootstrap these tenant resources, but Markdown Magpie validates tokens at runtime.
```

- [x] **Step 3: Update MCP docs**

Document:

- HTTP MCP uses OAuth protected-resource metadata.
- `/mcp` requires `Authorization: Bearer <token>` when `AUTH_REQUIRED=true`.
- stdio uses `MCP_AUTH_TOKEN`.
- HTTP MCP calls the API using `MCP_API_AUTH_TOKEN`.

- [x] **Step 4: Commit**

```bash
git add .env.example .env.compose.example README.md docs/mcp.md
git commit -m "docs: document auth0 configuration"
```

## Task 7: Full Verification

**Files:**
- All changed files.

- [ ] **Step 1: Run focused tests**

```bash
npm run test -w @magpie/auth
npm run test -w @magpie/api -- src/app.test.ts
npm run test -w @magpie/mcp
```

Expected: all PASS.

- [ ] **Step 2: Run repo checks**

```bash
npm run typecheck
npm run lint
npm run test
```

Expected: all PASS.

- [ ] **Step 3: Build**

```bash
npm run build
```

Expected: all workspaces build successfully.

- [ ] **Step 4: Commit any verification fixes**

If verification required code changes:

```bash
git add apps/api apps/mcp apps/web packages/auth .env.example .env.compose.example README.md docs/mcp.md package.json package-lock.json
git commit -m "fix: stabilize auth0 integration"
```

If no changes are needed, do not create an empty commit.

## Self-Review

- Spec coverage: Auth0 setup, UI/API/MCP auth, stdio token handling, tests, and docs are covered by Tasks 1-7.
- Placeholder scan: no `TBD`, `TODO`, or open-ended implementation steps remain.
- Type consistency: shared names are `AuthSettings`, `Principal`, `requireAuth`, `requireScopes`, `MCP_AUTH_TOKEN`, and `MCP_API_AUTH_TOKEN` throughout.
