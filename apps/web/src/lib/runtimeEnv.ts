import type { RuntimeConfigEnv } from "./runtimeConfig";

// The env the runtime config resolves from, read on the server per request.
// Each NEXT_PUBLIC_* var is referenced literally so Next.js can inline a
// build-time value; the rest resolve from the running container's env. Shared by
// the root layout (window.__MAGPIE_CONFIG__) and the proxy (the CSP's
// connect-src), so the policy always allows exactly the origins the console is
// configured to call.
export function runtimeConfigEnv(): RuntimeConfigEnv {
  return {
    NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
    PUBLIC_API_BASE_URL: process.env.PUBLIC_API_BASE_URL,
    NEXT_PUBLIC_MCP_URL: process.env.NEXT_PUBLIC_MCP_URL,
    MCP_RESOURCE_URL: process.env.MCP_RESOURCE_URL,
    NEXT_PUBLIC_AUTH_PROVIDER: process.env.NEXT_PUBLIC_AUTH_PROVIDER,
    AUTH_PROVIDER: process.env.AUTH_PROVIDER,
    NEXT_PUBLIC_AUTH_ISSUER: process.env.NEXT_PUBLIC_AUTH_ISSUER,
    AUTH_ISSUER: process.env.AUTH_ISSUER,
    NEXT_PUBLIC_AUTH_CLIENT_ID: process.env.NEXT_PUBLIC_AUTH_CLIENT_ID,
    AUTH_CLIENT_ID: process.env.AUTH_CLIENT_ID,
    NEXT_PUBLIC_AUTH_AUDIENCE: process.env.NEXT_PUBLIC_AUTH_AUDIENCE,
    AUTH_AUDIENCE: process.env.AUTH_AUDIENCE,
    NEXT_PUBLIC_AUTH_REDIRECT_URI: process.env.NEXT_PUBLIC_AUTH_REDIRECT_URI,
    AUTH_REDIRECT_URI: process.env.AUTH_REDIRECT_URI,
    NEXT_PUBLIC_AUTH_API_ID_URI: process.env.NEXT_PUBLIC_AUTH_API_ID_URI,
    AUTH_API_ID_URI: process.env.AUTH_API_ID_URI,
    NEXT_PUBLIC_AUTH0_DOMAIN: process.env.NEXT_PUBLIC_AUTH0_DOMAIN,
    AUTH0_ISSUER_BASE_URL: process.env.AUTH0_ISSUER_BASE_URL,
    AUTH0_DOMAIN: process.env.AUTH0_DOMAIN,
    NEXT_PUBLIC_AUTH0_CLIENT_ID: process.env.NEXT_PUBLIC_AUTH0_CLIENT_ID,
    AUTH0_CLIENT_ID: process.env.AUTH0_CLIENT_ID,
    NEXT_PUBLIC_AUTH0_AUDIENCE: process.env.NEXT_PUBLIC_AUTH0_AUDIENCE,
    AUTH0_AUDIENCE: process.env.AUTH0_AUDIENCE,
    NEXT_PUBLIC_AUTH0_REDIRECT_URI: process.env.NEXT_PUBLIC_AUTH0_REDIRECT_URI,
    AUTH0_REDIRECT_URI: process.env.AUTH0_REDIRECT_URI
  };
}
