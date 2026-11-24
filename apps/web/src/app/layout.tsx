import type { ReactNode } from "react";
import Script from "next/script";
import { EmotionRegistry } from "../theme/EmotionRegistry";
import { ConsoleProvider } from "../components/ConsoleProvider";
import { AppShell } from "../components/AppShell";
import { AuthProvider } from "../components/AuthProvider";
import { resolveRuntimeConfig, serializeRuntimeConfig } from "../lib/runtimeConfig";

// Render at request time so the env reads below resolve against the running
// container's environment, not whatever was set during `next build`. This is
// what makes the published image distributable: NEXT_PUBLIC_* values are inlined
// at build time, but the non-prefixed fallbacks (AUTH_*, legacy AUTH0_*,
// PUBLIC_API_BASE_URL) are read here per-request and injected into
// window.__MAGPIE_CONFIG__.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: ReactNode }) {
  // Each NEXT_PUBLIC_* var is referenced literally so Next.js can inline a
  // build-time value; the rest resolve from the running container's env.
  const runtimeConfig = resolveRuntimeConfig({
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
  });

  return (
    <html lang="en">
      <body>
        {/*
          Inject the runtime API base URL (read by lib/api.ts) via next/script so it
          runs before hydration. Using a raw <script> here makes React warn that the
          tag won't execute on the client; next/script is the App Router-supported way.

          serializeRuntimeConfig (not raw JSON.stringify) is used because this string is
          injected as literal HTML via dangerouslySetInnerHTML: an unescaped config value
          containing "</script>" would terminate the tag early and inject markup/script.
        */}
        <Script
          id="magpie-runtime-config"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `window.__MAGPIE_CONFIG__=${serializeRuntimeConfig(runtimeConfig)};`
          }}
        />
        <EmotionRegistry>
          <AuthProvider config={runtimeConfig.auth}>
            <ConsoleProvider>
              <AppShell>{children}</AppShell>
            </ConsoleProvider>
          </AuthProvider>
        </EmotionRegistry>
      </body>
    </html>
  );
}
