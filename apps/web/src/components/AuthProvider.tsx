"use client";

import { ErrorResponse, UserManager, WebStorageStateStore, type User } from "oidc-client-ts";
import { AuthProvider as OidcProvider, useAuth } from "react-oidc-context";
import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from "react";
import styled from "@emotion/styled";
import { setAccessTokenProvider } from "../lib/api";
import { buildOidcSettings } from "../lib/authSettings";
import { BrowserAuthConfig, isAuthConfigured } from "../lib/runtimeConfig";
import { Landing } from "./Landing";

// The console's app-owned view of authentication. Components read it through
// useConsoleAuth() and never import the OIDC library directly, so the library
// stays an implementation detail of this file. The hook is safe everywhere: with
// auth disabled no OIDC provider is mounted and it returns DISABLED_AUTH.
export interface ConsoleAuth {
  enabled: boolean;
  isLoading: boolean;
  isAuthenticated: boolean;
  // Display label for the signed-in user (email, else name), when known.
  userLabel: string | undefined;
  login: () => void;
  logout: () => void;
}

const noop = (): void => undefined;

const DISABLED_AUTH: ConsoleAuth = {
  enabled: false,
  isLoading: false,
  isAuthenticated: false,
  userLabel: undefined,
  login: noop,
  logout: noop
};

const LOADING_AUTH: ConsoleAuth = { ...DISABLED_AUTH, enabled: true, isLoading: true };

const ConsoleAuthContext = createContext<ConsoleAuth>(DISABLED_AUTH);

export function useConsoleAuth(): ConsoleAuth {
  return useContext(ConsoleAuthContext);
}

export function AuthProvider({ children, config }: { children: ReactNode; config: BrowserAuthConfig }) {
  if (!isAuthConfigured(config)) {
    return <>{children}</>;
  }
  return <OidcAuthProvider config={config}>{children}</OidcAuthProvider>;
}

function createUserManager(config: BrowserAuthConfig): UserManager {
  // For a browser SPA the OAuth callback must return to the exact origin the app
  // is served from, so derive redirect_uri from window.location.origin rather
  // than trusting the configured value. This makes login immune to a misconfigured
  // AUTH_REDIRECT_URI / AUTH0_REDIRECT_URI (wrong scheme/host) — a real deployment
  // failure mode where e.g. http://host was set but only https://host is an
  // allowed callback. The configured value is only an SSR-render fallback, which
  // never reaches the IdP. Logout returns to the origin too.
  const origin = window.location.origin || config.redirectUri;
  return new UserManager({
    ...buildOidcSettings(config, origin),
    // Persists the session (access + refresh token) in localStorage, so it's
    // readable by any future XSS on this origin. Accepted trade-off for now: the
    // console renders AI Markdown via react-markdown without rehype-raw, ships
    // strong security headers, and exposes no NEXT_PUBLIC_* secrets, while the
    // alternatives are worse UX — in-memory/sessionStorage forces re-login on
    // every reload or new tab, and hidden-iframe silent SSO is broken by
    // third-party-cookie blocking in Safari/Chrome. The proper fix is a
    // Backend-for-Frontend that keeps tokens off the browser entirely; tracked
    // as #316.
    userStore: new WebStorageStateStore({ store: window.localStorage })
  });
}

// After the login redirect the IdP returns with ?code&state (or ?error). Once
// the library has exchanged them, strip them so a reload doesn't replay a spent
// code and the URL stays clean. Module-level so its identity is stable.
function stripSigninParams(): void {
  window.history.replaceState({}, document.title, window.location.pathname);
}

function OidcAuthProvider({ children, config }: { children: ReactNode; config: BrowserAuthConfig }) {
  // UserManager needs window (storage, location); during SSR there is none, so
  // render the same splash the client shows while the session resolves.
  const [userManager] = useState(() => (typeof window === "undefined" ? undefined : createUserManager(config)));
  if (!userManager) {
    return (
      <ConsoleAuthContext.Provider value={LOADING_AUTH}>
        <Splash />
      </ConsoleAuthContext.Provider>
    );
  }
  return (
    <OidcProvider userManager={userManager} onSigninCallback={stripSigninParams}>
      <AuthGate userManager={userManager}>{children}</AuthGate>
    </OidcProvider>
  );
}

// Renew this many seconds before expiry rather than sending a token that may
// lapse in flight.
const EXPIRY_SKEW_SECONDS = 30;

// The stored access token when it is present and not about to expire.
function freshAccessToken(user: User | null): string | undefined {
  if (!user?.access_token) {
    return undefined;
  }
  return user.expires_in === undefined || user.expires_in > EXPIRY_SKEW_SECONDS ? user.access_token : undefined;
}

// The access-token provider registered with lib/api. Returns the stored token
// while it's fresh, otherwise renews via the refresh token (concurrent callers
// share one renewal, so rotation never sees a refresh token used twice). When
// renewal is impossible — no refresh token, or the IdP rejected the grant
// (expired/revoked/rotated-away refresh token) — the session is dead: clear it
// and send the user back through login, leaving the caller pending while the
// page navigates away. Transient failures (network, timeout) are rethrown so the
// request fails visibly instead of bouncing the user to the IdP.
function createAccessTokenProvider(userManager: UserManager): () => Promise<string> {
  let renewal: Promise<User | null> | undefined;
  let loginRedirect: Promise<string> | undefined;

  const redirectToLogin = (): Promise<string> => {
    loginRedirect ??= userManager
      .removeUser()
      .then(() => userManager.signinRedirect())
      .then(() => new Promise<string>(() => undefined));
    return loginRedirect;
  };

  return async () => {
    const user = await userManager.getUser();
    const token = freshAccessToken(user);
    if (token) {
      return token;
    }
    if (!user?.refresh_token) {
      return redirectToLogin();
    }
    try {
      renewal ??= userManager.signinSilent().finally(() => {
        renewal = undefined;
      });
      const renewed = await renewal;
      if (renewed?.access_token) {
        return renewed.access_token;
      }
    } catch (error) {
      if (!(error instanceof ErrorResponse)) {
        throw error;
      }
    }
    return redirectToLogin();
  };
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

type RestoreState = "idle" | "pending" | "done";

// Gates the data-fetching console behind authentication. The app subtree (which
// fetches on mount and polls) only renders once the user is signed in AND the
// access-token provider is armed, so there is never a token-less request race on
// first load. Unauthenticated visitors get the Landing page instead.
function AuthGate({ children, userManager }: { children: ReactNode; userManager: UserManager }) {
  const auth = useAuth();
  const { isAuthenticated, isLoading, user, signinRedirect, signoutRedirect } = auth;
  const [tokenProviderReady, setTokenProviderReady] = useState(false);
  const [restore, setRestore] = useState<RestoreState>("idle");

  // A stored session whose access token already expired (e.g. the tab was
  // closed overnight) loads as unauthenticated, and background renewal only
  // fires ahead of expiry. Renew it once via the refresh token so a returning
  // user lands in the console instead of on the login page; if that fails the
  // stale session is cleared and the Landing page shows.
  const canRestore = !isLoading && !isAuthenticated && Boolean(user?.refresh_token);
  useEffect(() => {
    if (!canRestore || restore !== "idle") {
      return;
    }
    setRestore("pending");
    userManager
      .signinSilent()
      .catch(() => userManager.removeUser())
      .finally(() => setRestore("done"));
  }, [canRestore, restore, userManager]);

  useEffect(() => {
    if (isAuthenticated) {
      setAccessTokenProvider(createAccessTokenProvider(userManager));
      setTokenProviderReady(true);
    } else {
      setAccessTokenProvider(undefined);
      setTokenProviderReady(false);
    }
    return () => setAccessTokenProvider(undefined);
  }, [isAuthenticated, userManager]);

  const consoleAuth = useMemo<ConsoleAuth>(
    () => ({
      enabled: true,
      isLoading,
      isAuthenticated,
      userLabel: user?.profile.email ?? user?.profile.name ?? user?.profile.preferred_username,
      login: () => void signinRedirect(),
      // RP-initiated logout via the IdP's end_session_endpoint, returning to this
      // origin. The local session is cleared first, so even if the IdP exposes
      // no end_session_endpoint the console still signs out locally. The
      // settings-level extraQueryParams (Auth0's `audience`) are authorize-only.
      logout: () => void signoutRedirect({ extraQueryParams: {} })
    }),
    [isAuthenticated, isLoading, signinRedirect, signoutRedirect, user]
  );

  let content: ReactNode;
  // Session still resolving, an expired session being restored, or signed in
  // but the provider effect hasn't armed the token yet (effects run after
  // render) — hold so children never mount with an unarmed provider.
  if (
    isLoading ||
    restore === "pending" ||
    (canRestore && restore === "idle") ||
    (isAuthenticated && !tokenProviderReady)
  ) {
    content = <Splash />;
  } else if (!isAuthenticated) {
    content = <Landing onLogin={consoleAuth.login} />;
  } else {
    content = children;
  }
  return <ConsoleAuthContext.Provider value={consoleAuth}>{content}</ConsoleAuthContext.Provider>;
}
