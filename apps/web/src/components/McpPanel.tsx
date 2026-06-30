"use client";

import { useState } from "react";

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
    <div className="surface">
      <div className="surfaceHeader">
        <h2>Connect over MCP</h2>
      </div>
      <div className="surfaceBody">
        <p className="mcpIntro">
          The Markdown Magpie MCP server lets your AI tools query this knowledge base directly — search sections,
          ask cited questions, and report gaps without leaving your editor. Point any MCP client at the endpoint
          below, then sign in through the browser when prompted.
        </p>

        <div className="mcpEndpoint">
          <span className="mcpEndpointLabel">Server endpoint</span>
          <CopyBlock code={mcpUrl} oneLine />
        </div>

        <p className="mcpChooseHint">Use whichever applies to your client:</p>

        <div className="mcpClients">
          <article className="promptCard">
            <div className="promptCardHead">
              <h3>Claude Code</h3>
            </div>
            <p className="promptOutput">Add the server with one command, then run in your terminal:</p>
            <CopyBlock code={cliCommand} />
            <p className="promptOutput">
              Then run <code>/mcp</code> inside Claude Code to trigger the browser OAuth login.
            </p>
          </article>

          <article className="promptCard">
            <div className="promptCardHead">
              <h3>Claude Desktop, VS Code, Cursor &amp; Continue</h3>
            </div>
            <p className="promptOutput">Add the server to the client&apos;s MCP configuration:</p>
            <CopyBlock code={jsonConfig} />
            <p className="promptOutput">
              The first request prompts you to sign in through the browser; the client remembers the session
              afterwards.
            </p>
          </article>
        </div>

        <div className="mcpTools">
          <h3 className="mcpToolsTitle">Once connected</h3>
          <p className="promptOutput">Your client gains these tools:</p>
          <ul className="mcpToolList">
            {TOOLS.map((tool) => (
              <li className="mcpTool" key={tool.name}>
                <code>{tool.name}</code>
                <span>{tool.blurb}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

// A dark code block with a copy button. Copies the raw text to the clipboard and
// shows a brief "Copied" confirmation. oneLine renders short single-line values
// (like the endpoint URL) without wrapping.
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
    <div className="mcpCode">
      <pre className={oneLine ? "promptInstructions mcpCodeInline" : "promptInstructions"}>{code}</pre>
      <button className="mcpCodeCopy" onClick={copy} type="button" aria-label="Copy to clipboard">
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
