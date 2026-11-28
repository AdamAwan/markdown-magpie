import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const distDir = process.env.NEXT_DIST_DIR ?? (process.env.NODE_ENV === "production" ? ".next-build" : ".next-dev");

// Optional dev-only proxy: when MAGPIE_DEV_API_PROXY is set (e.g. to
// http://localhost:4000), same-origin /api/* requests are forwarded to a local
// API so the browser avoids cross-origin/CORS issues. Unset in Docker/prod
// (which run web + API same-origin behind a reverse proxy), so this is inert there.
const devApiProxy = process.env.MAGPIE_DEV_API_PROXY?.replace(/\/+$/, "");

// Standard security headers applied to every route as defense-in-depth. HSTS is
// only honoured by browsers over HTTPS, so it is inert in plain-HTTP local dev;
// production is expected to terminate TLS upstream. The Content-Security-Policy
// is NOT here: it carries a per-request script nonce, so src/proxy.ts sets it
// (policy in src/lib/csp.ts).
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Strict-Transport-Security", value: "max-age=15552000; includeSubDomains" },
  // The console signs in by full-page redirect (no popups), so it can isolate
  // its browsing context from cross-origin openers.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" }
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir,
  // Don't advertise the framework (X-Powered-By: Next.js).
  poweredByHeader: false,
  outputFileTracingRoot: workspaceRoot,
  // Enable SWC's Emotion transform: readable class labels in dev + source maps, and
  // `css` prop support. Replaces the need for a Babel plugin.
  compiler: { emotion: true },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  async rewrites() {
    if (!devApiProxy) {
      return [];
    }
    return [{ source: "/api/:path*", destination: `${devApiProxy}/api/:path*` }];
  }
};

export default nextConfig;
