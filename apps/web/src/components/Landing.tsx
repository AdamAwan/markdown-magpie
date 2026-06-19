"use client";

import Image from "next/image";

// Publicly shown demo credentials so evaluators can sign in. This is a
// deliberately shared, throwaway demo account — keep it scoped/limited in Auth0.
const DEMO_EMAIL = "demo@example.com";
const DEMO_PASSWORD = "demo@example.com123";

// Unauthenticated landing page. Rendered by the auth gate whenever there is no
// authenticated session, so the data-fetching console never mounts (and never
// fires token-less API requests) until the user has signed in.
export function Landing({ onLogin }: { onLogin: () => void }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
        background: "#f5f7f2"
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 420,
          background: "#ffffff",
          border: "1px solid #d8e0d8",
          borderRadius: 16,
          padding: "32px",
          boxShadow: "0 12px 40px rgba(23, 33, 29, 0.08)",
          textAlign: "center"
        }}
      >
        <Image
          src="/magpie.jpeg"
          alt=""
          aria-hidden="true"
          width={64}
          height={64}
          style={{ borderRadius: 12, margin: "0 auto" }}
        />
        <p
          style={{
            margin: "16px 0 4px",
            color: "#65716b",
            fontSize: 12,
            fontWeight: 750,
            letterSpacing: "0.08em",
            textTransform: "uppercase"
          }}
        >
          Markdown Magpie
        </p>
        <h1 style={{ marginBottom: 8 }}>Knowledge Console</h1>
        <p style={{ marginBottom: 24 }}>Sign in to search, ask, and manage your Markdown knowledge base.</p>

        <button
          className="button"
          type="button"
          onClick={onLogin}
          style={{ width: "100%", justifyContent: "center", borderRadius: 10 }}
        >
          Log in
        </button>

        <div
          style={{
            marginTop: 24,
            padding: "14px 16px",
            background: "#f5f7f2",
            border: "1px solid #e1e7e1",
            borderRadius: 12,
            textAlign: "left"
          }}
        >
          <p style={{ margin: 0, fontWeight: 800, color: "#17211d", fontSize: 13 }}>Demo login</p>
          <dl
            style={{
              margin: "8px 0 0",
              display: "grid",
              gridTemplateColumns: "auto 1fr",
              columnGap: 12,
              rowGap: 4,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 13,
              color: "#17211d"
            }}
          >
            <dt style={{ color: "#65716b" }}>email</dt>
            <dd style={{ margin: 0 }}>{DEMO_EMAIL}</dd>
            <dt style={{ color: "#65716b" }}>password</dt>
            <dd style={{ margin: 0 }}>{DEMO_PASSWORD}</dd>
          </dl>
          <p style={{ margin: "10px 0 0", fontSize: 12 }}>
            Enter these at the login prompt to explore the demo.
          </p>
        </div>
      </div>
    </div>
  );
}
