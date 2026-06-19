"use client";

import { ReactNode, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useAuth0 } from "@auth0/auth0-react";
import { ConsoleSection } from "../lib/types";
import { extractModelInfo } from "../lib/config";
import { sectionSubtitle, sectionTitle } from "../lib/console";
import { SECTION_NAV, sectionFromPath } from "../lib/sections";
import { AttentionPanel, NavButton } from "./common";
import { useConsole } from "./ConsoleProvider";
import { authConfiguredFromWindow } from "./AuthProvider";

// Login/logout controls. This is only rendered when Auth0 is configured, since
// useAuth0 throws without an Auth0Provider ancestor (AuthProvider omits the
// provider entirely when auth is disabled).
function AuthActions() {
  const { isAuthenticated, isLoading, user, loginWithRedirect, logout } = useAuth0();
  if (isLoading) {
    return <span className="refreshTime">Checking session</span>;
  }
  if (!isAuthenticated) {
    return (
      <button className="button secondary" onClick={() => void loginWithRedirect()} type="button">
        Log in
      </button>
    );
  }
  return (
    <>
      <span className="refreshTime">{user?.email ?? user?.name ?? "Signed in"}</span>
      <button
        className="button secondary"
        onClick={() => logout({ logoutParams: { returnTo: window.location.origin } })}
        type="button"
      >
        Log out
      </button>
    </>
  );
}

// Shared console chrome: sidebar (brand, nav, live status) and the topbar. It is
// rendered once by the root layout and wraps the active section route as
// `children`, deriving the active section from the URL so a refresh highlights
// the right nav entry and shows the right title.
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const activeSection = sectionFromPath(pathname);
  const {
    health,
    stats,
    questions,
    gaps,
    jobs,
    proposals,
    crunchRuns,
    prompts,
    config,
    latestJob,
    attentionNotices,
    refreshing,
    lastRefreshedAt,
    message,
    refresh
  } = useConsole();

  // URL parsing/host detection; memoised so it doesn't re-run on every render
  // (the provider re-renders on each 4s poll).
  const modelInfo = useMemo(() => extractModelInfo(config), [config]);

  // Whether to show the auth controls. Resolved after mount so the server and
  // initial client render match (the runtime config lives on window only), and
  // so AuthActions (which calls useAuth0) mounts only when an Auth0Provider is
  // present, i.e. when auth is configured.
  const [authEnabled, setAuthEnabled] = useState(false);
  useEffect(() => {
    setAuthEnabled(authConfiguredFromWindow());
  }, []);

  const counts: Partial<Record<ConsoleSection, number>> = {
    ask: questions.length,
    knowledge: stats.sectionCount,
    gaps: gaps.length,
    jobs: jobs.length,
    proposals: proposals.length,
    crunch: crunchRuns.length,
    prompts: prompts.length
  };

  return (
    <div className="appShell">
      <aside className="sidebar">
        <div className="brand">
          <Image className="brandLogo" src="/magpie.jpeg" alt="" aria-hidden="true" width={40} height={40} />
          <div className="brandText">
            <span>Markdown Magpie</span>
            <strong>Knowledge Console</strong>
          </div>
        </div>
        <nav className="sideNav" aria-label="Console sections">
          {SECTION_NAV.map((entry) => (
            <NavButton
              key={entry.section}
              active={activeSection === entry.section}
              count={counts[entry.section]}
              glyph={entry.glyph}
              label={entry.label}
              href={entry.path}
            />
          ))}
        </nav>
        <div className="sideStatus">
          <div className="statusGroup">
            <p className="statusGroupTitle">System</p>
            <div className="statusLine">
              <span>API</span>
              <span>
                <span className={health?.ok ? "dot" : "dot offline"} />
                {health?.ok ? "Online" : "Offline"}
              </span>
            </div>
            <div className="statusLine">
              <span>Documents</span>
              <span>{stats.documentCount}</span>
            </div>
            <div className="statusLine">
              <span>Sections</span>
              <span>{stats.sectionCount}</span>
            </div>
            <div className="statusLine">
              <span>Latest Job</span>
              <span>
                {latestJob ? <span className={latestJob.status === "failed" ? "dot offline" : "dot"} /> : null}
                {latestJob ? latestJob.status : "None"}
              </span>
            </div>
          </div>

          <div className="statusGroup">
            <p className="statusGroupTitle">Model</p>
            <div className="statusLine">
              <span>Mode</span>
              <span>{config?.aiRuntime.executionMode ?? "direct"}</span>
            </div>
            {modelInfo.chatModel && (
              <div className="statusLine">
                <span>Chat</span>
                <span title={modelInfo.chatHost || undefined}>
                  {modelInfo.chatModel}
                  {modelInfo.chatHost && ` (${modelInfo.chatHost})`}
                </span>
              </div>
            )}
            {modelInfo.embeddingModel && (
              <div className="statusLine">
                <span>Embedding</span>
                <span title={modelInfo.embeddingHost || undefined}>
                  {modelInfo.embeddingModel}
                  {modelInfo.embeddingHost && ` (${modelInfo.embeddingHost})`}
                </span>
              </div>
            )}
            <div className="statusLine">
              <span>Retrieval</span>
              <span title={config?.retrieval.reason}>
                {config?.retrieval.mode === "hybrid" ? "Hybrid (semantic + keyword)" : "Keyword only"}
              </span>
            </div>
          </div>

          <div className="statusGroup">
            <p className="statusGroupTitle">Session</p>
            <div className="statusLine">
              <span>Updated</span>
              <span>{lastRefreshedAt ? new Date(lastRefreshedAt).toLocaleTimeString() : "Never"}</span>
            </div>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <p className="eyebrow">Markdown Magpie</p>
            <h1>{sectionTitle(activeSection)}</h1>
            <p>{sectionSubtitle(activeSection)}</p>
          </div>
          <div className="topActions">
            <span className="refreshTime" aria-live="polite">
              {lastRefreshedAt ? `Updated ${new Date(lastRefreshedAt).toLocaleTimeString()}` : "Not refreshed yet"}
            </span>
            <button className="button secondary" disabled={refreshing} onClick={() => void refresh()} type="button">
              {refreshing ? "Refreshing" : "Refresh"}
            </button>
            {authEnabled ? <AuthActions /> : null}
          </div>
        </header>

        {message ? (
          <div className={`alert ${message.tone}`} role="status" aria-live="polite">
            {message.text}
          </div>
        ) : null}
        {attentionNotices.length ? <AttentionPanel notices={attentionNotices} /> : null}

        {children}
      </main>
    </div>
  );
}
