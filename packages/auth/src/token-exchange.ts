// RFC 8693 OAuth 2.0 Token Exchange.
//
// The HTTP MCP server authenticates the END USER at its edge, then needs to call
// the downstream API *as that user* so the API's own flow-scoped authorization
// applies. It cannot forward the user's inbound token directly: that token's
// audience is the MCP resource, not the API. Instead it exchanges the user's token
// for an API-audience token that preserves the user's identity (subject + roles),
// using its own confidential-client credentials to authenticate the exchange.
//
// This is distinct from api-token.ts (client-credentials, the MCP's *own* service
// identity). Exchange yields a *per-user* token; the service token is a single
// process-wide identity.

const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

// Refresh this many seconds before the exchanged token expires, so an in-flight
// request never races the expiry boundary. Matches api-token.ts.
const EXPIRY_SKEW_SECONDS = 60;

// A cap on the number of distinct subject tokens cached at once, so a long-running
// server that sees many users can't grow the cache without bound. Expired entries
// are pruned first; if still over the cap, the whole cache is cleared (correctness
// is preserved — a cleared entry is simply re-exchanged on next use).
const MAX_CACHE_ENTRIES = 2000;

export interface TokenExchangeConfig {
  // The OAuth token endpoint, e.g. https://<tenant>/oauth/token.
  tokenUrl: string;
  // The confidential client performing the exchange (the MCP's own M2M app).
  clientId: string;
  clientSecret: string;
  // The audience of the token we want back — the downstream API identifier.
  audience: string;
  // The type of the subject token being exchanged. Defaults to an access token;
  // override for providers/flows that expect a different subject_token_type.
  subjectTokenType?: string;
  // Optional space-delimited scope to request on the exchanged token.
  scope?: string;
}

// Exchanges the caller's (verified) subject token for a downstream API token.
export type TokenExchanger = (subjectToken: string) => Promise<string>;

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
}

interface CacheEntry {
  token: string;
  expiresAt: number;
}

export function createTokenExchanger(config: TokenExchangeConfig): TokenExchanger {
  // Keyed by the exact subject token string, so one user's exchanged token can
  // never be returned for another. Bounded by MAX_CACHE_ENTRIES + TTL eviction.
  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<string>>();

  async function exchange(subjectToken: string): Promise<string> {
    const body = new URLSearchParams({
      grant_type: GRANT_TYPE,
      subject_token: subjectToken,
      subject_token_type: config.subjectTokenType ?? ACCESS_TOKEN_TYPE,
      requested_token_type: ACCESS_TOKEN_TYPE,
      audience: config.audience,
      client_id: config.clientId,
      client_secret: config.clientSecret
    });
    if (config.scope) {
      body.set("scope", config.scope);
    }

    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Token exchange failed (${response.status}): ${text}`);
    }

    const parsed = (text ? JSON.parse(text) : {}) as TokenResponse;
    if (!parsed.access_token) {
      throw new Error("Token exchange response did not include an access_token");
    }

    const ttlSeconds = typeof parsed.expires_in === "number" && parsed.expires_in > 0 ? parsed.expires_in : 3600;
    pruneCache();
    cache.set(subjectToken, {
      token: parsed.access_token,
      expiresAt: nowSeconds() * 1000 + Math.max(0, ttlSeconds - EXPIRY_SKEW_SECONDS) * 1000
    });
    return parsed.access_token;
  }

  function pruneCache(): void {
    const now = nowSeconds() * 1000;
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= now) {
        cache.delete(key);
      }
    }
    if (cache.size >= MAX_CACHE_ENTRIES) {
      cache.clear();
    }
  }

  return async (subjectToken: string): Promise<string> => {
    const cached = cache.get(subjectToken);
    if (cached && nowSeconds() * 1000 < cached.expiresAt) {
      return cached.token;
    }

    // Collapse concurrent exchanges of the same subject token (a single kb.ask
    // makes several downstream calls) into one network round-trip.
    let pending = inflight.get(subjectToken);
    if (!pending) {
      pending = exchange(subjectToken).finally(() => {
        inflight.delete(subjectToken);
      });
      inflight.set(subjectToken, pending);
    }
    return pending;
  };
}

// Wall-clock seconds. Extracted so it reads clearly at the call sites; Date.now is
// the ambient clock (this module is not exercised under the workflow sandbox that
// stubs it).
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
