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
// production is expected to terminate TLS upstream.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Strict-Transport-Security", value: "max-age=15552000; includeSubDomains" }
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir,
  outputFileTracingRoot: workspaceRoot,
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
