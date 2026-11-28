import { NextResponse, type NextRequest } from "next/server";
import { buildContentSecurityPolicy, createNonce } from "./lib/csp";
import { runtimeConfigEnv } from "./lib/runtimeEnv";

// Sets the console's per-request Content-Security-Policy (see lib/csp.ts). The
// policy goes on the REQUEST headers too: that is where Next.js reads the nonce
// from to stamp it on its own scripts while rendering, and the layout reads the
// `x-nonce` header for its inline runtime-config script. Pages are dynamically
// rendered (app/layout.tsx), which a per-request nonce requires.
export function proxy(request: NextRequest): NextResponse {
  const nonce = createNonce();
  const policy = buildContentSecurityPolicy({
    nonce,
    development: process.env.NODE_ENV === "development",
    env: runtimeConfigEnv()
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: [
    {
      // Documents only: not the (dev-proxied) API, static chunks, images or the
      // favicon, and not router prefetches, which render no document.
      source: "/((?!api|_next/static|_next/image|favicon.ico|icon.jpeg).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" }
      ]
    }
  ]
};
