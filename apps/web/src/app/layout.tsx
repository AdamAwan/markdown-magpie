import type { ReactNode } from "react";
import Script from "next/script";
import "./styles.css";
import { ConsoleProvider } from "../components/ConsoleProvider";
import { AppShell } from "../components/AppShell";

export default function RootLayout({ children }: { children: ReactNode }) {
  const runtimeConfig = {
    apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL || process.env.PUBLIC_API_BASE_URL || ""
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
        <ConsoleProvider>
          <AppShell>{children}</AppShell>
        </ConsoleProvider>
      </body>
    </html>
  );
}
