"use client";

import { useState } from "react";
import styled from "@emotion/styled";
import { Surface } from "./ui";

// The public endpoint of the deployed MCP server, resolved from runtime config
// (window.__MAGPIE_CONFIG__.mcpUrl, injected by the root layout) with a
// build-time NEXT_PUBLIC_MCP_URL override and a local-dev fallback. Kept out of
// source so the deployed host is configured per environment, not hardcoded.
function resolveMcpUrl(): string {
  if (typeof window !== "undefined" && window.__MAGPIE_CONFIG__?.mcpUrl) {
    return window.__MAGPIE_CONFIG__.mcpUrl;
  }
  return process.env.NEXT_PUBLIC_MCP_URL || "http://localhost:4001/mcp";
}

const Intro = styled.p(({ theme }) => ({
  margin: 0,
  maxWidth: "70ch",
  color: theme.color.textMuted,
  lineHeight: 1.55
}));

const Endpoint = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.sm
}));

const EndpointLabel = styled.span(({ theme }) => ({
  fontSize: theme.font.size.xs,
  letterSpacing: "0.02em",
  color: theme.color.textSubtle
}));

const ChooseHint = styled.p(({ theme }) => ({
  margin: `${theme.space.xs} 0 0`,
  fontWeight: theme.font.weight.semibold,
  color: theme.color.text
}));

// The two clients are alternatives, not ordered steps — lay them out as peer
// cards rather than a numbered pipeline.
const Clients = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.xl
}));

const ClientCard = styled.article(({ theme }) => ({
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.card,
  padding: theme.space.xl,
  background: theme.color.surface,
  display: "grid",
  gap: theme.space.lg
}));

const ClientCardHead = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: theme.space.lg,
  "& h3": { margin: 0, fontSize: theme.font.size.lg }
}));

const Output = styled.p(({ theme }) => ({
  margin: 0,
  fontSize: theme.font.size.base,
  color: theme.color.textMuted
}));

const Tools = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.lg,
  padding: theme.space.xl,
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.card,
  background: theme.color.surfaceMuted
}));

const ToolsTitle = styled.h3(({ theme }) => ({
  margin: 0,
  fontSize: theme.font.size.lg
}));

const ToolList = styled.ul(({ theme }) => ({
  margin: 0,
  padding: 0,
  listStyle: "none",
  display: "grid",
  gap: theme.space.md
}));

const ToolItem = styled.li(({ theme }) => ({
  display: "flex",
  alignItems: "baseline",
  gap: theme.space.lg,
  flexWrap: "wrap",
  "& code": { flex: "0 0 auto" },
  "& > span": { color: theme.color.textMuted, fontSize: theme.font.size.base }
}));

// The tools the server exposes once a client is connected — kept in sync with the
// kb_* tools registered by the MCP server.
const TOOLS: { name: string; blurb: string }[] = [
  { name: "kb_search", blurb: "Search indexed Markdown sections by keyword." },
  { name: "kb_ask", blurb: "Ask a question and get a cited answer from the knowledge base." },
  { name: "kb_feedback", blurb: "Flag an answer as helpful, unhelpful, or a knowledge gap." }
];

// Read-only guide: how to point an MCP client at the deployed server and what it
// can do once connected. Authentication is browser OAuth, triggered on first use.
export function McpPanel() {
  const mcpUrl = resolveMcpUrl();
  const cliCommand = `claude mcp add --transport http markdown-magpie ${mcpUrl}`;
  const jsonConfig = `{
  "mcpServers": {
    "markdown-magpie": {
      "type": "http",
      "url": "${mcpUrl}"
    }
  }
}`;

  return (
    <Surface>
      <Surface.Header>
        <h2>Connect over MCP</h2>
      </Surface.Header>
      <Surface.Body>
        <Intro>
          The Markdown Magpie MCP server lets your AI tools query this knowledge base directly — search sections,
          ask cited questions, and report gaps without leaving your editor. Point any MCP client at the endpoint
          below, then sign in through the browser when prompted.
        </Intro>

        <Endpoint>
          <EndpointLabel>Server endpoint</EndpointLabel>
          <CopyBlock code={mcpUrl} oneLine />
        </Endpoint>

        <ChooseHint>Use whichever applies to your client:</ChooseHint>

        <Clients>
          <ClientCard>
            <ClientCardHead>
              <h3>Claude Code</h3>
            </ClientCardHead>
            <Output>Add the server with one command, then run in your terminal:</Output>
            <CopyBlock code={cliCommand} />
            <Output>
              Then run <code>/mcp</code> inside Claude Code to trigger the browser OAuth login.
            </Output>
          </ClientCard>

          <ClientCard>
            <ClientCardHead>
              <h3>Claude Desktop, VS Code, Cursor &amp; Continue</h3>
            </ClientCardHead>
            <Output>Add the server to the client&apos;s MCP configuration:</Output>
            <CopyBlock code={jsonConfig} />
            <Output>
              The first request prompts you to sign in through the browser; the client remembers the session
              afterwards.
            </Output>
          </ClientCard>
        </Clients>

        <Tools>
          <ToolsTitle>Once connected</ToolsTitle>
          <Output>Your client gains these tools:</Output>
          <ToolList>
            {TOOLS.map((tool) => (
              <ToolItem key={tool.name}>
                <code>{tool.name}</code>
                <span>{tool.blurb}</span>
              </ToolItem>
            ))}
          </ToolList>
        </Tools>
      </Surface.Body>
    </Surface>
  );
}

// A dark code block with a copy button. Copies the raw text to the clipboard and
// shows a brief "Copied" confirmation. oneLine renders short single-line values
// (like the endpoint URL) without wrapping.
const CodeWrap = styled.div({
  // The wrapper is the positioning context for the copy button.
  position: "relative"
});

const CodeBlock = styled.pre<{ $oneLine: boolean }>(({ theme, $oneLine }) => ({
  margin: 0,
  padding: theme.space.lg,
  // Leave room for the copy button so long lines never sit under it.
  paddingRight: "72px",
  background: theme.color.text,
  color: theme.color.page,
  borderRadius: theme.radius.md,
  whiteSpace: $oneLine ? "nowrap" : "pre-wrap",
  wordBreak: "break-word",
  fontFamily: theme.font.mono,
  fontSize: theme.font.size.sm,
  lineHeight: 1.45,
  overflowX: "auto"
}));

const CopyButton = styled.button(({ theme }) => ({
  position: "absolute",
  top: theme.space.md,
  right: theme.space.md,
  minHeight: "28px",
  border: `1px solid ${theme.color.textMuted}`,
  borderRadius: theme.radius.sm,
  background: theme.color.primaryHover,
  color: theme.color.page,
  padding: `${theme.space.xs} ${theme.space.lg}`,
  fontSize: theme.font.size.sm,
  fontWeight: theme.font.weight.semibold,
  cursor: "pointer",
  "&:hover": { background: theme.color.primary }
}));

function CopyBlock({ code, oneLine = false }: { code: string; oneLine?: boolean }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      })
      // Clipboard access can be denied (e.g. an unfocused tab); fail quietly
      // rather than throwing — the code is still visible and selectable.
      .catch(() => undefined);
  };

  return (
    <CodeWrap>
      <CodeBlock $oneLine={oneLine}>{code}</CodeBlock>
      <CopyButton onClick={copy} type="button" aria-label="Copy to clipboard">
        {copied ? "Copied" : "Copy"}
      </CopyButton>
    </CodeWrap>
  );
}
