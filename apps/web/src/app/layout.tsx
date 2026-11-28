import type { ReactNode } from "react";
import { headers } from "next/headers";
import Script from "next/script";
import { EmotionRegistry } from "../theme/EmotionRegistry";
import { ConsoleProvider } from "../components/ConsoleProvider";
import { AppShell } from "../components/AppShell";
import { AuthProvider } from "../components/AuthProvider";
import { resolveRuntimeConfig, serializeRuntimeConfig } from "../lib/runtimeConfig";
import { runtimeConfigEnv } from "../lib/runtimeEnv";

// Render at request time so the env reads below resolve against the running
// container's environment, not whatever was set during `next build`. This is
// what makes the published image distributable: NEXT_PUBLIC_* values are inlined
// at build time, but the non-prefixed fallbacks (AUTH_*, legacy AUTH0_*,
// PUBLIC_API_BASE_URL) are read here per-request and injected into
// window.__MAGPIE_CONFIG__.
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: ReactNode }) {
  const runtimeConfig = resolveRuntimeConfig(runtimeConfigEnv());
  // The per-request CSP nonce the proxy minted (src/proxy.ts). Next.js stamps it
  // on its own scripts; the inline runtime-config script below needs it passed
  // explicitly or the policy blocks it.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

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
          nonce={nonce}
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
