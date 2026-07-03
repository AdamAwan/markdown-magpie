import type { ReactNode } from "react";
import Script from "next/script";
import "./styles.css";
import { EmotionRegistry } from "../theme/EmotionRegistry";
import { ConsoleProvider } from "../components/ConsoleProvider";
import { AppShell } from "../components/AppShell";
import { AuthProvider } from "../components/AuthProvider";

// Render at request time so the env reads below resolve against the running
// container's environment, not whatever was set during `next build`. This is
// what makes the published image distributable: NEXT_PUBLIC_* values are inlined
// at build time, but the non-prefixed fallbacks (AUTH0_*, PUBLIC_API_BASE_URL)
// are read here per-request and injected into window.__MAGPIE_CONFIG__.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: ReactNode }) {
  const runtimeConfig = {
    apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL || process.env.PUBLIC_API_BASE_URL || "",
    mcpUrl: process.env.NEXT_PUBLIC_MCP_URL || process.env.MCP_RESOURCE_URL || "",
    auth: {
      domain: process.env.NEXT_PUBLIC_AUTH0_DOMAIN || process.env.AUTH0_DOMAIN || "",
      clientId: process.env.NEXT_PUBLIC_AUTH0_CLIENT_ID || process.env.AUTH0_CLIENT_ID || "",
      audience: process.env.NEXT_PUBLIC_AUTH0_AUDIENCE || process.env.AUTH0_AUDIENCE || "",
      redirectUri:
        process.env.NEXT_PUBLIC_AUTH0_REDIRECT_URI || process.env.AUTH0_REDIRECT_URI || "http://localhost:3000"
    }
  };

  return (
    <html lang="en">
      <body>
        {/*
          Inject the runtime API base URL (read by lib/api.ts) via next/script so it
          runs before hydration. Using a raw <script> here makes React warn that the
          tag won't execute on the client; next/script is the App Router-supported way.
        */}
        <Script
          id="magpie-runtime-config"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `window.__MAGPIE_CONFIG__=${JSON.stringify(runtimeConfig)};`
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
