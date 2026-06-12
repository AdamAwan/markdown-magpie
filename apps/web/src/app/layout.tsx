import type { ReactNode } from "react";
import "./styles.css";

export default function RootLayout({ children }: { children: ReactNode }) {
  const runtimeConfig = {
    apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL || process.env.PUBLIC_API_BASE_URL || ""
  };

  return (
    <html lang="en">
      <body>
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__MAGPIE_CONFIG__=${JSON.stringify(runtimeConfig)};`
          }}
        />
        {children}
      </body>
    </html>
  );
}
