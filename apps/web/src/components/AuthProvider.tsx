"use client";

import { Auth0Provider, useAuth0 } from "@auth0/auth0-react";
import { ReactNode, useEffect, useRef, useState } from "react";
import styled from "@emotion/styled";
import { setAccessTokenProvider } from "../lib/api";
import { Landing } from "./Landing";

export interface BrowserAuthConfig {
  domain: string;
  clientId: string;
  audience: string;
  redirectUri: string;
}

function isAuthEnabled(config: BrowserAuthConfig): boolean {
  return Boolean(config.domain && config.clientId && config.audience);
}

// API scopes the console requests so the issued access token actually carries
// permissions for the web API. Without an explicit `scope`, the Auth0 SDK only
// requests `openid profile email`, yielding a token the API rejects/forbids on
// every protected route. These mirror the web API's defined permissions; an
// authorized user is granted the subset they're allowed (all of them when the
// API's user policy is allow_all and RBAC is off).
const API_SCOPES = [
  "read:knowledge",
  "ask:knowledge",
  "feedback:questions",
  "manage:knowledge",
  "manage:jobs",
  "manage:admin"
].join(" ");

const REQUESTED_SCOPE = `openid profile email ${API_SCOPES}`;

function isMissingRefreshTokenError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "error" in error &&
    (error as { error?: unknown }).error === "missing_refresh_token"
  );
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
      authorizationParams={{ audience: config.audience, redirect_uri: redirectUri, scope: REQUESTED_SCOPE }}
      cacheLocation="localstorage"
      useRefreshTokens
    >
      <AuthGate>{children}</AuthGate>
    </Auth0Provider>
  );
}

const SplashScreen = styled.div(({ theme }) => ({
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: theme.color.page,
  color: theme.color.textMuted,
  fontWeight: theme.font.weight.semibold
}));

function Splash() {
  return <SplashScreen>Loading…</SplashScreen>;
}

// Gates the data-fetching console behind authentication. The app subtree (which
// fetches on mount and polls) only renders once the user is signed in AND the
// access-token provider is armed, so there is never a token-less request race on
// first load. Unauthenticated visitors get the Landing page instead.
function AuthGate({ children }: { children: ReactNode }) {
  const { getAccessTokenSilently, isAuthenticated, isLoading, loginWithRedirect, logout } = useAuth0();
  const [tokenProviderReady, setTokenProviderReady] = useState(false);
  const loginRedirectRef = useRef<Promise<string> | undefined>(undefined);

  useEffect(() => {
    if (isAuthenticated) {
      setAccessTokenProvider(async () => {
        try {
          return await getAccessTokenSilently();
        } catch (error) {
          if (!isMissingRefreshTokenError(error)) {
            throw error;
          }

          // Auth0 can retain an authenticated user while its local refresh token
          // is missing. Clear that stale session and return to the login page.
          loginRedirectRef.current ??= logout({
            logoutParams: { returnTo: window.location.origin }
          }).then(() => new Promise<string>(() => undefined));
          return loginRedirectRef.current;
        }
      });
      setTokenProviderReady(true);
    } else {
      setAccessTokenProvider(undefined);
      setTokenProviderReady(false);
    }
    return () => setAccessTokenProvider(undefined);
  }, [getAccessTokenSilently, isAuthenticated, logout]);

  // Session still resolving, or signed in but the provider effect hasn't armed
  // the token yet (effects run after render) — hold so children never mount with
  // an unarmed provider.
  if (isLoading || (isAuthenticated && !tokenProviderReady)) {
    return <Splash />;
  }
  if (!isAuthenticated) {
    return <Landing onLogin={() => void loginWithRedirect()} />;
  }
  return <>{children}</>;
}
