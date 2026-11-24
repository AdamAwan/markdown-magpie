// Service-token provider for downstream API calls made by backend services (the
// HTTP MCP server and the watcher).
//
// Such a service authenticates to the Markdown Magpie API with its OWN
// machine-to-machine credential (never an inbound user token). Historically this
// was a static token pasted into the environment — but Auth0 access tokens expire
// (default 24h), so a static token silently breaks every call a day after deploy.
// This module fetches the token at runtime via the OAuth client-credentials grant
// and caches it until shortly before expiry, refreshing transparently.
//
// The request shape is provider-specific (see provider.ts): Auth0 takes a JSON body
// naming the API `audience`; Entra takes a form-encoded body requesting the
// `${apiIdUri}/.default` scope.

import { providerProfile, type AuthProvider } from "./provider.js";

export interface ApiTokenProviderConfig {
  // Legacy static token (e.g. MCP_API_AUTH_TOKEN / API_TOKEN). Used as a fallback
  // when no client-credentials config is supplied, preserving prior behaviour.
  staticToken?: string;
  // Client-credentials configuration (preferred). clientId, clientSecret, tokenUrl
  // and audience are required to enable runtime token acquisition — plus apiIdUri
  // for Entra.
  provider?: AuthProvider; // defaults to auth0
  clientId?: string;
  clientSecret?: string;
  tokenUrl?: string; // e.g. https://<tenant>/oauth/token (Auth0), .../oauth2/v2.0/token (Entra)
  audience?: string; // the downstream API audience (the web API identifier)
  apiIdUri?: string; // Entra: the API's Application ID URI (scope = `${apiIdUri}/.default`)
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
}

// Refresh this many seconds before the token actually expires, so an in-flight
// request never races the expiry boundary.
const EXPIRY_SKEW_SECONDS = 60;

export type ApiTokenProvider = () => Promise<string | undefined>;

export function createApiTokenProvider(config: ApiTokenProviderConfig): ApiTokenProvider {
  const { clientId, clientSecret, tokenUrl, audience } = config;
  const request =
    clientId && clientSecret && tokenUrl && audience
      ? providerProfile(config.provider).clientCredentialsRequest({
          clientId,
          clientSecret,
          audience,
          apiIdUri: config.apiIdUri
        })
      : undefined;

  if (!request || !tokenUrl) {
    // No M2M config: fall back to the static token (which may be undefined when
    // auth is disabled — callers then send no Authorization header).
    return async () => config.staticToken;
  }

  // Captured after the guard so the hoisted fetchToken closure sees narrowed values.
  const endpoint = tokenUrl;
  const { contentType, body: requestBody } = request;
  let cached: { token: string; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;

  async function fetchToken(): Promise<string> {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": contentType },
      body: requestBody
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Failed to obtain API service token (${response.status}): ${text}`);
    }

    const body = (text ? JSON.parse(text) : {}) as TokenResponse;
    if (!body.access_token) {
      throw new Error("Token endpoint response did not include an access_token");
    }

    const ttlSeconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
    cached = {
      token: body.access_token,
      expiresAt: Date.now() + Math.max(0, ttlSeconds - EXPIRY_SKEW_SECONDS) * 1000
    };
    return cached.token;
  }

  return async () => {
    if (cached && Date.now() < cached.expiresAt) {
      return cached.token;
    }
    // Collapse concurrent refreshes so a burst of requests triggers one fetch.
    inflight ??= fetchToken().finally(() => {
      inflight = undefined;
    });
    return inflight;
  };
}
