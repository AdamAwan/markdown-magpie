// Runtime configuration the root layout (app/layout.tsx) resolves per request
// from the web server's environment and injects into window.__MAGPIE_CONFIG__.
// Resolving here (not via NEXT_PUBLIC_* alone) keeps one prebuilt image
// configurable per deployment with no rebuild.

// Identity provider the console signs in against. Both are spoken to through the
// same generic OIDC client; only the authority/scope/extra-param shaping differs
// (see lib/authSettings.ts).
type AuthProviderKind = "auth0" | "entra";

export interface BrowserAuthConfig {
  provider: AuthProviderKind;
  // OIDC issuer / authority. auth0: https://<domain>/ (exactly one trailing
  // slash). entra: verbatim, e.g. https://login.microsoftonline.com/<tenant>/v2.0.
  issuer: string;
  // The console's SPA client id.
  clientId: string;
  // The web API's audience. auth0: the API identifier, sent as the `audience`
  // authorize param. entra: the API app registration's client id (only used to
  // default apiIdUri).
  audience: string;
  // Configured redirect URI. Only an SSR fallback: the browser always uses its
  // own origin (see components/AuthProvider.tsx).
  redirectUri: string;
  // entra: the API's Application ID URI that delegated scopes are prefixed with
  // (`${apiIdUri}/read:knowledge`). Defaults to api://<audience>. Unused by auth0.
  apiIdUri: string;
}

export interface MagpieRuntimeConfig {
  apiBaseUrl: string;
  mcpUrl: string;
  auth: BrowserAuthConfig;
}

declare global {
  interface Window {
    __MAGPIE_CONFIG__?: Partial<Omit<MagpieRuntimeConfig, "auth">> & { auth?: Partial<BrowserAuthConfig> };
  }
}

// Every env var the runtime config reads. The new generic AUTH_* names win over
// the legacy AUTH0_* names (kept as fallbacks so existing Auth0 deployments need
// no env changes); within each tier the build-time NEXT_PUBLIC_* form wins over
// the runtime form, matching the long-standing precedence.
export interface RuntimeConfigEnv {
  NEXT_PUBLIC_API_BASE_URL?: string;
  PUBLIC_API_BASE_URL?: string;
  NEXT_PUBLIC_MCP_URL?: string;
  MCP_RESOURCE_URL?: string;
  NEXT_PUBLIC_AUTH_PROVIDER?: string;
  AUTH_PROVIDER?: string;
  NEXT_PUBLIC_AUTH_ISSUER?: string;
  AUTH_ISSUER?: string;
  NEXT_PUBLIC_AUTH_CLIENT_ID?: string;
  AUTH_CLIENT_ID?: string;
  NEXT_PUBLIC_AUTH_AUDIENCE?: string;
  AUTH_AUDIENCE?: string;
  NEXT_PUBLIC_AUTH_REDIRECT_URI?: string;
  AUTH_REDIRECT_URI?: string;
  NEXT_PUBLIC_AUTH_API_ID_URI?: string;
  AUTH_API_ID_URI?: string;
  // Legacy Auth0 names.
  NEXT_PUBLIC_AUTH0_DOMAIN?: string;
  AUTH0_ISSUER_BASE_URL?: string;
  AUTH0_DOMAIN?: string;
  NEXT_PUBLIC_AUTH0_CLIENT_ID?: string;
  AUTH0_CLIENT_ID?: string;
  NEXT_PUBLIC_AUTH0_AUDIENCE?: string;
  AUTH0_AUDIENCE?: string;
  NEXT_PUBLIC_AUTH0_REDIRECT_URI?: string;
  AUTH0_REDIRECT_URI?: string;
}

const DEFAULT_REDIRECT_URI = "http://localhost:3000";

// First non-blank value, trimmed; "" when none is set.
function firstSet(...values: (string | undefined)[]): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return "";
}

function parseAuthProvider(value: string): AuthProviderKind {
  const normalized = value.toLowerCase();
  if (normalized === "" || normalized === "auth0") {
    return "auth0";
  }
  if (normalized === "entra") {
    return "entra";
  }
  throw new Error(`AUTH_PROVIDER must be "auth0" or "entra" (got "${value}").`);
}

// A legacy AUTH0_DOMAIN is a bare host; the issuer is https://<domain>/.
function issuerFromAuth0Domain(domain: string): string {
  return domain === "" || /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
}

// Auth0 issuers carry exactly one trailing slash (the `iss` Auth0 stamps).
function withOneTrailingSlash(url: string): string {
  return url === "" ? url : `${url.replace(/\/+$/, "")}/`;
}

export function resolveAuthConfig(env: RuntimeConfigEnv): BrowserAuthConfig {
  const provider = parseAuthProvider(firstSet(env.NEXT_PUBLIC_AUTH_PROVIDER, env.AUTH_PROVIDER));
  const rawIssuer = firstSet(
    env.NEXT_PUBLIC_AUTH_ISSUER,
    env.AUTH_ISSUER,
    issuerFromAuth0Domain(firstSet(env.NEXT_PUBLIC_AUTH0_DOMAIN)),
    env.AUTH0_ISSUER_BASE_URL,
    issuerFromAuth0Domain(firstSet(env.AUTH0_DOMAIN))
  );
  const audience = firstSet(
    env.NEXT_PUBLIC_AUTH_AUDIENCE,
    env.AUTH_AUDIENCE,
    env.NEXT_PUBLIC_AUTH0_AUDIENCE,
    env.AUTH0_AUDIENCE
  );
  const apiIdUri = firstSet(env.NEXT_PUBLIC_AUTH_API_ID_URI, env.AUTH_API_ID_URI, audience && `api://${audience}`);
  return {
    provider,
    // Entra's v2 issuer has no trailing slash and must be used verbatim.
    issuer: provider === "auth0" ? withOneTrailingSlash(rawIssuer) : rawIssuer,
    clientId: firstSet(
      env.NEXT_PUBLIC_AUTH_CLIENT_ID,
      env.AUTH_CLIENT_ID,
      env.NEXT_PUBLIC_AUTH0_CLIENT_ID,
      env.AUTH0_CLIENT_ID
    ),
    audience,
    redirectUri:
      firstSet(
        env.NEXT_PUBLIC_AUTH_REDIRECT_URI,
        env.AUTH_REDIRECT_URI,
        env.NEXT_PUBLIC_AUTH0_REDIRECT_URI,
        env.AUTH0_REDIRECT_URI
      ) || DEFAULT_REDIRECT_URI,
    apiIdUri: apiIdUri.replace(/\/+$/, "")
  };
}

export function resolveRuntimeConfig(env: RuntimeConfigEnv): MagpieRuntimeConfig {
  return {
    apiBaseUrl: firstSet(env.NEXT_PUBLIC_API_BASE_URL, env.PUBLIC_API_BASE_URL),
    mcpUrl: firstSet(env.NEXT_PUBLIC_MCP_URL, env.MCP_RESOURCE_URL),
    auth: resolveAuthConfig(env)
  };
}

// Auth is on when the issuer, client id and audience are all configured; any
// missing leaves the console in auth-disabled mode (no OIDC provider mounted).
export function isAuthConfigured(config: BrowserAuthConfig): boolean {
  return Boolean(config.issuer && config.clientId && config.audience);
}

// Serializes the runtime config object for injection into an inline <script>
// tag (see app/layout.tsx). `JSON.stringify` alone does not escape `<`, so a
// config value containing the literal substring `</script>` could terminate
// the inline script element early and inject arbitrary markup/script into the
// page (a classic HTML-context script-injection). Config values are
// operator-controlled env today, not user input, so this isn't currently
// exploitable -- but we harden it anyway since the config is rendered as raw
// HTML via `dangerouslySetInnerHTML`.
//
// Escaping `<` -> `\u003c` neutralizes `</script>` (and any other tag) while
// still round-tripping through `JSON.parse` to the original value, since
// `\uXXXX` is a valid JSON/JS string escape. U+2028/U+2029 (line/paragraph
// separators) are also escaped: they're valid in JSON strings but are raw
// line terminators in JS, which can break script parsing outside of a JSON
// string context. The regex literals below use \u escape sequences (not the
// raw characters) so this source file itself stays plain ASCII.
export function serializeRuntimeConfig(config: unknown): string {
  return JSON.stringify(config)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
