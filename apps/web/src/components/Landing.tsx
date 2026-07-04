"use client";

import Image from "next/image";
import styled from "@emotion/styled";
import { Button } from "./ui";

const Page = styled.div(({ theme }) => ({
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: theme.space.xxl,
  background: theme.color.page
}));

const Card = styled.div(({ theme }) => ({
  width: "100%",
  maxWidth: 420,
  background: theme.color.surface,
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.card,
  padding: theme.space.xxl,
  boxShadow: theme.shadow.card,
  textAlign: "center"
}));

const Eyebrow = styled.p(({ theme }) => ({
  margin: `${theme.space.xl} 0 ${theme.space.xs}`,
  color: theme.color.textMuted,
  fontSize: theme.font.size.sm,
  fontWeight: theme.font.weight.semibold,
  letterSpacing: "0.08em"
}));

// The "View presentation" control is a link, not a button, so it can't be the
// Button primitive (which renders a <button>). Mirror the secondary Button's
// look on an anchor instead.
const PresentationLink = styled.a(({ theme }) => ({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "100%",
  minHeight: "36px",
  marginTop: theme.space.md,
  padding: `${theme.space.md} ${theme.space.lg}`,
  border: `1px solid ${theme.color.borderStrong}`,
  borderRadius: theme.radius.sm,
  background: theme.color.surface,
  color: theme.color.text,
  fontFamily: theme.font.sans,
  fontSize: theme.font.size.md,
  fontWeight: theme.font.weight.semibold,
  textDecoration: "none",
  transition: "background 120ms ease, border-color 120ms ease",
  "&:hover": { background: theme.color.surfaceMuted }
}));

const DemoBox = styled.div(({ theme }) => ({
  marginTop: theme.space.xxl,
  padding: `${theme.space.lg} ${theme.space.xl}`,
  background: theme.color.page,
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.card,
  textAlign: "left"
}));

const DemoTitle = styled.p(({ theme }) => ({
  margin: 0,
  color: theme.color.text,
  fontSize: theme.font.size.md,
  fontWeight: theme.font.weight.semibold
}));

const DemoBody = styled.p(({ theme }) => ({
  margin: `${theme.space.md} 0 0`,
  fontSize: theme.font.size.md
}));

// Unauthenticated landing page. Rendered by the auth gate whenever there is no
// authenticated session, so the data-fetching console never mounts (and never
// fires token-less API requests) until the user has signed in.
export function Landing({ onLogin }: { onLogin: () => void }) {
  return (
    <Page>
      <Card>
        <Image
          src="/magpie.jpeg"
          alt=""
          aria-hidden="true"
          width={64}
          height={64}
          style={{ borderRadius: 12, margin: "0 auto" }}
        />
        <Eyebrow>Markdown Magpie</Eyebrow>
        <h1 style={{ marginBottom: 8 }}>Knowledge Console</h1>
        <p style={{ marginBottom: 24 }}>Sign in to search, ask, and manage your Markdown knowledge base.</p>

        <Button variant="primary" type="button" onClick={onLogin} style={{ width: "100%" }}>
          Log in
        </Button>

        <PresentationLink href="/presentation/index.html">View presentation</PresentationLink>

        <DemoBox>
          <DemoTitle>Demo access</DemoTitle>
          <DemoBody>Contact the admin for demo credentials.</DemoBody>
        </DemoBox>
      </Card>
    </Page>
  );
}
