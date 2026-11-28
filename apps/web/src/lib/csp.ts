import { resolveRuntimeConfig, type RuntimeConfigEnv } from "./runtimeConfig";

// The console's Content-Security-Policy (docs/security-review.md). The console
// keeps its OIDC session in localStorage, so a script-injection bug would hand
// an attacker the user's tokens; this policy is the containment for that.
//
// - Scripts: nonce-based with 'strict-dynamic'. The proxy (src/proxy.ts) mints a
//   fresh nonce per request; Next.js reads it from the request's CSP header and
//   stamps it on every framework script, and the layout passes it to its own
//   inline runtime-config <Script>. No inline script without the nonce runs, and
//   no script can be loaded from another origin. 'unsafe-eval' is added in
//   development only (React's dev tooling uses eval; production never does).
// - Styles: 'unsafe-inline'. Emotion injects <style> tags at runtime and the UI
//   (React Flow, Recharts) uses style attributes; CSS cannot run script, so this
//   is the conventional, low-risk relaxation.
// - Connections: this origin, the API's origin when it is served elsewhere
//   (NEXT_PUBLIC_API_BASE_URL / PUBLIC_API_BASE_URL), and the identity
//   provider's origin (OIDC discovery, token and refresh calls against the
//   Auth0 domain or login.microsoftonline.com). All resolved from the same
//   runtime env the layout injects, so one image stays deployable anywhere.
// - Frames: only the identity provider (oidc-client-ts's hidden-iframe silent
//   renew, if it is ever used instead of the refresh token); nothing may frame
//   the console except itself.

// The origin of an absolute http(s) URL, or undefined for a relative/blank one
// (a same-origin API base is already covered by 'self').
function originOf(url: string): string | undefined {
  if (!/^https?:\/\//i.test(url)) {
    return undefined;
  }
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export interface CspOptions {
  nonce: string;
  // NODE_ENV=development: allow 'unsafe-eval' and the dev server's websocket.
  development: boolean;
  env: RuntimeConfigEnv;
}

export function buildContentSecurityPolicy({ nonce, development, env }: CspOptions): string {
  const runtime = resolveRuntimeConfig(env);
  const apiOrigin = originOf(runtime.apiBaseUrl);
  const idpOrigin = originOf(runtime.auth.issuer);
  const unique = (values: Array<string | undefined>): string[] => [
    ...new Set(values.filter((value): value is string => value !== undefined))
  ];

  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(development ? ["'unsafe-eval'"] : [])]],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:"]],
    ["font-src", ["'self'", "data:"]],
    ["connect-src", unique(["'self'", apiOrigin, idpOrigin, ...(development ? ["ws:"] : [])])],
    ["frame-src", idpOrigin ? [idpOrigin] : ["'none'"]],
    ["worker-src", ["'self'", "blob:"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'self'"]]
  ];
  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}

// A per-request nonce: 128 random bits, base64. Web Crypto is available in both
// the Node.js and edge proxy runtimes.
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
