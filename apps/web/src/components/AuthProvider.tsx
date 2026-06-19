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

function isAuthEnabled(config: BrowserAuthConfig): boolean {
  return Boolean(config.domain && config.clientId && config.audience);
}

// Whether Auth0 is configured, read from the runtime config injected by the
// root layout into window.__MAGPIE_CONFIG__. Components below AuthProvider use
// this to decide whether it is safe to call useAuth0 (which throws when there
// is no Auth0Provider ancestor, i.e. when auth is disabled).
export function authConfiguredFromWindow(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const auth = window.__MAGPIE_CONFIG__?.auth;
  return Boolean(auth?.domain && auth?.clientId && auth?.audience);
}

export function AuthProvider({ children, config }: { children: ReactNode; config: BrowserAuthConfig }) {
  if (!isAuthEnabled(config)) {
    return <>{children}</>;
  }
  // For a browser SPA the OAuth callback must return to the exact origin the app
  // is served from, so derive redirect_uri from window.location.origin rather
  // than trusting the configured value. This makes login immune to a misconfigured
  // AUTH0_REDIRECT_URI (wrong scheme/host) — a real deployment failure mode where
  // e.g. http://host was set but only https://host is an allowed callback. The
  // configured value is kept only as an SSR-render fallback (the real redirect
  // happens client-side, so the origin wins). logout already uses origin too.
  const redirectUri = typeof window !== "undefined" ? window.location.origin : config.redirectUri;
  return (
    <Auth0Provider
      domain={config.domain}
      clientId={config.clientId}
      authorizationParams={{ audience: config.audience, redirect_uri: redirectUri }}
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
  return <>{children}</>;
}
