import type { ReactNode } from "react";
import Script from "next/script";
import "./styles.css";
import { ConsoleProvider } from "../components/ConsoleProvider";
import { AppShell } from "../components/AppShell";
import { AuthProvider } from "../components/AuthProvider";

export default function RootLayout({ children }: { children: ReactNode }) {
  const runtimeConfig = {
    apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL || process.env.PUBLIC_API_BASE_URL || "",
    auth: {
      domain: process.env.NEXT_PUBLIC_AUTH0_DOMAIN || "",
      clientId: process.env.NEXT_PUBLIC_AUTH0_CLIENT_ID || "",
      audience: process.env.NEXT_PUBLIC_AUTH0_AUDIENCE || process.env.AUTH0_AUDIENCE || "",
      redirectUri: process.env.NEXT_PUBLIC_AUTH0_REDIRECT_URI || "http://localhost:3000"
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
        <AuthProvider config={runtimeConfig.auth}>
          <ConsoleProvider>
            <AppShell>{children}</AppShell>
          </ConsoleProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
