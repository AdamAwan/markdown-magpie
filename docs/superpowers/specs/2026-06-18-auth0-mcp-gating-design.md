# Auth0 and MCP gating - design

**Date:** 2026-06-18
**Status:** Proposed

## Problem

Markdown Magpie currently exposes three unauthenticated surfaces:

- The Next.js UI in `apps/web`.
- The Hono API in `apps/api`.
- The MCP server in `apps/mcp`, with both stdio and Streamable HTTP transports.

The goal is to gate all user-facing and agent-facing access with Auth0 while keeping
local development practical and making the HTTP MCP transport compatible with the
standard MCP authorization flow.

## Auth0 setup

Use the official Auth0 MCP server as a setup assistant, not as the runtime auth layer
for Markdown Magpie. It can create the Auth0 application/API records and write local
environment values, but Markdown Magpie still validates tokens itself.

Create these Auth0 resources:

- **Single Page Application:** `Markdown Magpie Web`
  - Allowed callback URL: `http://localhost:3000`
  - Allowed logout URL: `http://localhost:3000`
  - Allowed web origin: `http://localhost:3000`
- **API/resource server:** `Markdown Magpie`
  - Audience: `https://markdown-magpie.local/api` by default.
  - Signing algorithm: `RS256`.
  - Permissions:
    - `read:knowledge`
    - `ask:knowledge`
    - `feedback:questions`
    - `manage:knowledge`
    - `manage:jobs`
    - `manage:admin`
- **Machine-to-Machine Application:** `Markdown Magpie MCP Server`
  - Authorized to call the `Markdown Magpie` API.
  - Granted only the scopes needed by MCP tools:
    - `read:knowledge`
    - `ask:knowledge`
    - `feedback:questions`

The implementation must also work when these values are supplied manually through
environment variables, because Auth0 tenant setup is not part of the production
runtime.

## Environment

Add Auth0 configuration to `.env.example` and `.env.compose.example`:

- `AUTH0_DOMAIN`, for example `example.us.auth0.com`.
- `AUTH0_ISSUER_BASE_URL`, for example `https://example.us.auth0.com`.
- `AUTH0_AUDIENCE`, defaulting locally to `https://markdown-magpie.local/api`.
- `NEXT_PUBLIC_AUTH0_DOMAIN`.
- `NEXT_PUBLIC_AUTH0_CLIENT_ID`.
- `NEXT_PUBLIC_AUTH0_AUDIENCE`.
- `NEXT_PUBLIC_AUTH0_REDIRECT_URI`, defaulting to `http://localhost:3000`.
- `MCP_RESOURCE_URL`, defaulting to `http://localhost:4001/mcp`.
- `MCP_AUTH_TOKEN`, used only by the stdio MCP transport.
- `MCP_API_AUTH_TOKEN`, used by the HTTP MCP server when it calls the API after
  validating the user's MCP access token.
- `AUTH_REQUIRED`, defaulting to disabled when unset so existing tests and local
  development keep working until the variables are supplied.

When `AUTH_REQUIRED=true`, API and HTTP MCP requests must reject missing or invalid
tokens. When auth is disabled, routes should behave as they do today.

## UI flow

The web app uses Auth0's browser flow for a public client:

1. A user clicks login or lands on the app while unauthenticated.
2. Auth0 Universal Login authenticates them.
3. The browser app obtains an access token for `AUTH0_AUDIENCE` using authorization
   code with PKCE.
4. `apps/web/src/lib/api.ts` attaches `Authorization: Bearer <token>` to every API
   call.

The UI should show a small signed-in identity area with login/logout controls. It
should not duplicate API authorization logic; failed API calls remain server-driven
and display through the app's existing error handling.

## API authorization

Add shared auth code under `apps/api/src/auth`.

Responsibilities:

- Fetch and cache Auth0 JWKS keys.
- Validate RS256 JWT signature, issuer, audience, expiry, and token type.
- Extract scopes from the `scope` claim.
- Provide Hono middleware for required auth and required scopes.
- Return JSON errors:
  - `401 { "error": "unauthorized" }` for missing, malformed, expired, or invalid
    tokens.
  - `403 { "error": "forbidden" }` for valid tokens without required scopes.

Route policy:

- `/api/health` remains public.
- Read-only knowledge and prompt routes require `read:knowledge`.
- Asking requires `ask:knowledge`.
- Feedback requires `feedback:questions`.
- Source indexing, repository reset, proposals, crunch, scheduled tasks, and jobs
  require the relevant `manage:*` scope.
- Config/admin routes require `manage:admin`.

Scope checks should be route-level and explicit enough that future routes do not
accidentally inherit broad access.

## HTTP MCP authorization

The HTTP MCP server acts as an OAuth protected resource.

Add these behaviours to `apps/mcp/src/http.ts`:

- `GET /.well-known/oauth-protected-resource` returns protected-resource metadata
  pointing at the Auth0 issuer in `authorization_servers`.
- `GET /.well-known/oauth-protected-resource/mcp` returns the same metadata for
  clients that derive the metadata URL from the `/mcp` resource path.
- Missing or invalid tokens on `/mcp` return `401` with a `WWW-Authenticate` header
  that includes the protected-resource metadata URL.
- Valid tokens are required on every `GET`, `POST`, and `DELETE` request to `/mcp`.
- User tokens are validated locally and are never forwarded as passthrough
  credentials to downstream services.

The MCP server currently calls the Markdown Magpie API as a service client. In this
slice, the HTTP MCP server validates the user's MCP token and enforces tool scopes
at the MCP boundary, then calls the API with `MCP_API_AUTH_TOKEN`. That token should
come from the `Markdown Magpie MCP Server` machine-to-machine application. If
`AUTH_REQUIRED=true`, startup should fail fast when `MCP_API_AUTH_TOKEN` is missing.
If per-user API audit is needed later, add token exchange or a signed actor-context
header instead of forwarding the inbound user token.

Tool scope policy:

- `kb.search` requires `read:knowledge`.
- `kb.ask` requires `ask:knowledge`.
- `kb.feedback` requires `feedback:questions`.

## stdio MCP authorization

The stdio transport does not use the HTTP MCP OAuth discovery flow. It reads a token
from `MCP_AUTH_TOKEN` and sends it to the API on every request.

If `AUTH_REQUIRED=true` and `MCP_AUTH_TOKEN` is missing, the stdio server should fail
fast with a clear stderr message. The stdio token may be a user access token or a
machine-to-machine token with the necessary scopes. If auth is disabled, stdio keeps
current behaviour.

## API client changes in MCP

Update `apps/mcp/src/kb-client.ts` so all calls can include an optional bearer token.
HTTP transport calls use `MCP_API_AUTH_TOKEN`. stdio calls use `MCP_AUTH_TOKEN`.

## Testing

Add tests before implementation:

- API app tests:
  - With `AUTH_REQUIRED=true`, `/api/health` is public.
  - Protected API route without token returns 401.
  - Protected API route with invalid token returns 401.
  - Protected API route with valid token but missing scope returns 403.
  - Protected API route with valid scope reaches the existing handler.
- Auth utility tests:
  - JWT validation accepts a test RS256 token signed by a local test key.
  - Wrong audience, wrong issuer, expired token, and missing scope are rejected.
- MCP HTTP tests:
  - `/mcp` without auth returns 401 and `WWW-Authenticate`.
  - Protected-resource metadata includes the configured Auth0 issuer.
  - Valid scoped tokens allow tool calls.
  - Downstream API calls use `MCP_API_AUTH_TOKEN`, not the inbound user token.
- MCP stdio/unit tests:
  - Auth-required stdio startup rejects missing `MCP_AUTH_TOKEN`.
  - API calls include the bearer token when present.

## Documentation

Update:

- `.env.example` and `.env.compose.example` with Auth0 variables.
- `docs/mcp.md` with HTTP MCP OAuth behaviour and stdio token requirements.
- `README.md` with a minimal Auth0 dashboard checklist and a note that the official
  Auth0 MCP server can bootstrap tenant resources.

## Out of scope

- Auth0 FGA document-level permissions.
- Multi-tenant organizations.
- Machine-to-machine clients for background workers.
- Token exchange between separate API and MCP audiences.
- Custom Auth0 Actions.
- Production hosting configuration beyond environment variables and callback URL
  guidance.
