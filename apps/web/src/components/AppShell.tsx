"use client";

import { Fragment, ReactNode, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import styled from "@emotion/styled";
import { usePathname } from "next/navigation";
import { useAuth0 } from "@auth0/auth0-react";
import { ConsoleSection } from "../lib/types";
import { extractModelInfo } from "../lib/config";
import { isActiveJob, sectionSubtitle, sectionTitle } from "../lib/console";
import { SECTION_NAV, sectionFromPath } from "../lib/sections";
import { NavButton } from "./common";
import { useConsole } from "./ConsoleProvider";
import { authConfiguredFromWindow } from "./AuthProvider";
import { StatusPill } from "./StatusPill";
import { ToastStack } from "./ToastStack";
import { Button } from "./ui";

const MOBILE = "@media (max-width: 1050px)";
const NARROW = "@media (max-width: 700px)";

const Shell = styled.div({
  display: "grid",
  minHeight: "100vh",
  gridTemplateColumns: "236px minmax(0, 1fr)",
  [MOBILE]: { gridTemplateColumns: "1fr" }
});

const Sidebar = styled.aside(({ theme }) => ({
  position: "sticky",
  top: 0,
  height: "100vh",
  // Flex column so the brand stays put and the nav takes the remaining height
  // and scrolls internally — the sidebar can never clip its own content on a
  // short viewport (the old fixed-height block pushed the status off-screen).
  display: "flex",
  flexDirection: "column",
  borderRight: `1px solid ${theme.color.border}`,
  background: theme.color.surfaceMuted,
  padding: "18px 14px",
  [MOBILE]: {
    position: "static",
    height: "auto",
    display: "block",
    borderRight: 0,
    borderBottom: `1px solid ${theme.color.border}`,
    padding: "10px 14px"
  }
}));

const SidebarHeader = styled.div({
  display: "contents",
  [MOBILE]: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px" }
});

const Brand = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  gap: theme.space.md,
  padding: "8px 8px 20px",
  [MOBILE]: { padding: "4px 0" }
}));

const BrandLogo = styled(Image)(({ theme }) => ({
  width: "40px",
  height: "40px",
  flexShrink: 0,
  borderRadius: theme.radius.md,
  objectFit: "cover",
  background: theme.color.surface,
  border: `1px solid ${theme.color.border}`,
  [MOBILE]: { width: "36px", height: "36px" }
}));

const BrandText = styled.div({ minWidth: 0, [NARROW]: { "& > span": { display: "none" } } });

const BrandEyebrow = styled.span(({ theme }) => ({
  display: "block",
  color: theme.color.brandAccent,
  fontSize: theme.font.size.sm,
  fontWeight: theme.font.weight.semibold,
  textTransform: "uppercase"
}));

const BrandName = styled.strong(({ theme }) => ({
  display: "block",
  marginTop: "5px",
  fontSize: theme.font.size.xxl,
  lineHeight: 1.1,
  [MOBILE]: { marginTop: "2px", fontSize: theme.font.size.lg }
}));

const MenuToggle = styled.button(({ theme }) => ({
  display: "none",
  [MOBILE]: {
    display: "inline-flex",
    alignItems: "center",
    gap: theme.space.md,
    minHeight: "40px",
    border: `1px solid ${theme.color.border}`,
    borderRadius: theme.radius.sm,
    background: theme.color.surface,
    padding: `8px ${theme.space.lg}`,
    color: theme.color.text,
    fontSize: theme.font.size.base,
    fontWeight: theme.font.weight.semibold,
    cursor: "pointer"
  },
  "&:hover": { borderColor: theme.color.borderStrong, background: theme.color.page },
  "&:focus-visible": { outline: `3px solid ${theme.color.accentBg}`, outlineOffset: "2px" }
}));

const MenuToggleIcon = styled.span({
  display: "grid",
  gap: "3px",
  width: "16px",
  "& span": { display: "block", height: "2px", borderRadius: "2px", background: "currentColor" }
});

const SideNav = styled.nav<{ $open: boolean }>(({ theme, $open }) => ({
  display: "grid",
  gap: theme.space.xs,
  // Take the height left below the brand and scroll internally if the section
  // list is taller than the viewport, so no nav item is ever clipped. Pack the
  // items to the top (grid's default align-content stretches the rows, which
  // spread the items out across a tall viewport).
  flex: "1 1 auto",
  minHeight: 0,
  alignContent: "start",
  overflowY: "auto",
  [MOBILE]: $open
    ? {
        display: "grid",
        gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        marginTop: theme.space.lg,
        borderTop: `1px solid ${theme.color.border}`,
        paddingTop: theme.space.lg
      }
    : { display: "none" },
  [NARROW]: $open ? { gridTemplateColumns: "1fr" } : {}
}));

const NavDivider = styled.div(({ theme }) => ({
  gridColumn: "1 / -1",
  height: "1px",
  margin: `${theme.space.sm} ${theme.space.md}`,
  background: theme.color.border
}));

const MainArea = styled.main(({ theme }) => ({
  minWidth: 0,
  padding: "22px 24px 34px",
  [NARROW]: { padding: `${theme.space.xl} ${theme.space.lg} 28px` }
}));

const Topbar = styled.header(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: theme.space.xxl,
  marginBottom: theme.space.lg,
  "& p": { marginTop: theme.space.sm },
  [NARROW]: { display: "grid", gridTemplateColumns: "1fr" }
}));

const Eyebrow = styled.p(({ theme }) => ({
  display: "block",
  color: theme.color.brandAccent,
  fontSize: theme.font.size.sm,
  fontWeight: theme.font.weight.semibold,
  textTransform: "uppercase"
}));

const TopActions = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  gap: theme.space.md,
  [NARROW]: { alignItems: "stretch", flexDirection: "column" }
}));

const RefreshTime = styled.span(({ theme }) => ({
  color: theme.color.textMuted,
  fontSize: theme.font.size.sm,
  fontWeight: theme.font.weight.medium
}));

// Login/logout controls. This is only rendered when Auth0 is configured, since
// useAuth0 throws without an Auth0Provider ancestor (AuthProvider omits the
// provider entirely when auth is disabled).
function AuthActions() {
  const { isAuthenticated, isLoading, user, loginWithRedirect, logout } = useAuth0();
  if (isLoading) {
    return <RefreshTime>Checking session</RefreshTime>;
  }
  if (!isAuthenticated) {
    return (
      <Button variant="secondary" onClick={() => void loginWithRedirect()}>
        Log in
      </Button>
    );
  }
  return (
    <>
      <RefreshTime>{user?.email ?? user?.name ?? "Signed in"}</RefreshTime>
      <Button variant="secondary" onClick={() => logout({ logoutParams: { returnTo: window.location.origin } })}>
        Log out
      </Button>
    </>
  );
}

// Shared console chrome: the sidebar (brand + section nav) and the topbar
// (title + live status/notification popover). It is rendered once by the root
// layout and wraps the active section route as `children`, deriving the active
// section from the URL so a refresh highlights the right nav entry and shows
// the right title.
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const activeSection = sectionFromPath(pathname);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const {
    health,
    stats,
    questionsTotal,
    gaps,
    jobs,
    proposals,
    scheduledTasks,
    maintenanceRuns,
    prompts,
    config,
    attentionNotices,
    refreshing,
    lastRefreshedAt,
    notifications,
    toasts,
    refresh,
    dismissToast,
    dismissNotification,
    clearNotifications,
    markNotificationsRead
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

  // Every count and attention notice is derived from the single `refresh()` that
  // populates the whole console, so until it first completes the defaults (empty
  // arrays, sectionCount 0) are placeholders, not facts. `lastRefreshedAt` stays
  // undefined until that first load lands, so gate on it to avoid flashing "0"
  // badges and false "nothing is set up" warnings before the data arrives.
  const hasLoaded = lastRefreshedAt !== undefined;

  const counts: Partial<Record<ConsoleSection, number>> = hasLoaded
    ? {
        // The unpaginated total: the questions list is paged, so the loaded
        // page's length would under-report the backlog.
        ask: questionsTotal,
        knowledge: stats.sectionCount,
        gaps: gaps.length,
        jobs: jobs.filter((job) => isActiveJob(job) || job.state === "failed").length,
        proposals: proposals.length,
        activity: maintenanceRuns.filter((run) => run.status === "running").length,
        schedules: scheduledTasks.length,
        prompts: prompts.length
      }
    : {};

  // Live system/model status, surfaced in the topbar notification popover (it
  // used to live in a sidebar block that got clipped off short viewports).
  // Undefined until the first refresh lands, which hides the System group.
  const systemStatus = hasLoaded
    ? {
        apiOnline: Boolean(health?.ok),
        provider: config?.aiRuntime.provider ?? "not set",
        retrieval: config?.retrieval.mode === "hybrid" ? "Hybrid (semantic + keyword)" : "Keyword only",
        retrievalReason: config?.retrieval.reason,
        chatModel: modelInfo.chatModel,
        chatHost: modelInfo.chatHost,
        embeddingModel: modelInfo.embeddingModel,
        embeddingHost: modelInfo.embeddingHost
      }
    : undefined;

  return (
    <Shell>
      <Sidebar>
        <SidebarHeader>
          <Brand>
            <BrandLogo src="/magpie.jpeg" alt="" aria-hidden="true" width={40} height={40} />
            <BrandText>
              <BrandEyebrow>Markdown Magpie</BrandEyebrow>
              <BrandName>Knowledge Console</BrandName>
            </BrandText>
          </Brand>
          <MenuToggle
            type="button"
            aria-controls="console-navigation"
            aria-expanded={mobileMenuOpen}
            onClick={() => setMobileMenuOpen((open) => !open)}
          >
            <MenuToggleIcon aria-hidden="true">
              <span />
              <span />
              <span />
            </MenuToggleIcon>
            <span>{mobileMenuOpen ? "Close" : "Menu"}</span>
          </MenuToggle>
        </SidebarHeader>
        <SideNav
          $open={mobileMenuOpen}
          id="console-navigation"
          aria-label="Console sections"
          onClick={() => setMobileMenuOpen(false)}
        >
          {SECTION_NAV.map((entry, index) => (
            <Fragment key={entry.section}>
              {index > 0 && entry.group !== SECTION_NAV[index - 1].group ? <NavDivider role="presentation" /> : null}
              <NavButton
                active={activeSection === entry.section}
                count={counts[entry.section]}
                icon={entry.icon}
                label={entry.label}
                href={entry.path}
              />
            </Fragment>
          ))}
        </SideNav>
      </Sidebar>

      <MainArea>
        <Topbar>
          <div>
            <Eyebrow>Markdown Magpie</Eyebrow>
            <h1>{sectionTitle(activeSection)}</h1>
            <p>{sectionSubtitle(activeSection)}</p>
          </div>
          <TopActions>
            <RefreshTime aria-live="polite">
              {lastRefreshedAt ? `Updated ${new Date(lastRefreshedAt).toLocaleTimeString()}` : "Not refreshed yet"}
            </RefreshTime>
            <StatusPill
              loaded={hasLoaded}
              notices={hasLoaded ? attentionNotices : []}
              notifications={notifications}
              system={systemStatus}
              onOpen={markNotificationsRead}
              onDismissNotification={dismissNotification}
              onClearNotifications={clearNotifications}
            />
            <Button variant="secondary" disabled={refreshing} onClick={() => void refresh()}>
              {refreshing ? "Refreshing" : "Refresh"}
            </Button>
            {authEnabled ? <AuthActions /> : null}
          </TopActions>
        </Topbar>

        {children}

        <ToastStack toasts={toasts} onDismiss={dismissToast} />
      </MainArea>
    </Shell>
  );
}
