"use client";

import { useEffect, useRef, useState } from "react";
import styled from "@emotion/styled";
import { ConsoleNotice, UiNotification } from "../lib/types";
import { PillTone, pillSummary } from "../lib/console";
import { StatusRow } from "./common";
import { BuildStatus } from "./BuildStatus";
import { Chip, IconButton } from "./ui";
import type { StatusTone } from "../theme/theme";

// The compact live-status the topbar surfaces from the sidebar. Shaped by
// AppShell from the console health + runtime config so this component stays
// decoupled from the config types.
export interface SystemStatus {
  apiOnline: boolean;
  provider: string;
  retrieval: string;
  retrievalReason?: string;
  chatModel?: string;
  chatHost?: string;
  embeddingModel?: string;
  embeddingHost?: string;
}

// The pill's semantic tones on the theme's status palette. "neutral" keeps the
// completed-green dot so the healthy state still reads as a positive signal.
const pillStatusTone: Record<PillTone, StatusTone> = {
  danger: "failed",
  warning: "running",
  info: "pending",
  neutral: "neutral"
};

const noticeStatusTone: Record<ConsoleNotice["tone"], StatusTone> = {
  danger: "failed",
  warning: "running",
  info: "pending"
};

const notificationStatusTone: Record<UiNotification["tone"], StatusTone> = {
  danger: "failed",
  success: "completed",
  info: "pending"
};

// position: relative so the popover anchors to the pill inside the topbar.
const Anchor = styled.div({ position: "relative", display: "inline-flex" });

const Pill = styled.button<{ $tone: PillTone }>(({ theme, $tone }) => {
  const status = theme.color.status[pillStatusTone[$tone]];
  const quiet = $tone === "neutral";
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: theme.space.sm,
    minHeight: "34px",
    border: `1px solid ${quiet ? theme.color.border : status.border}`,
    borderRadius: "999px",
    background: quiet ? theme.color.surface : status.bg,
    color: quiet ? theme.color.textMuted : status.fg,
    padding: `5px ${theme.space.lg} 5px ${theme.space.md}`,
    fontSize: theme.font.size.sm,
    fontWeight: theme.font.weight.semibold,
    whiteSpace: "nowrap",
    cursor: "pointer",
    transition: "border-color 120ms ease, background 120ms ease",
    "&:hover": { borderColor: quiet ? theme.color.borderStrong : status.dot },
    "&:focus-visible": { outline: `3px solid ${theme.color.accentBg}`, outlineOffset: "2px" }
  };
});

const PillDot = styled.span<{ $tone: PillTone }>(({ theme, $tone }) => ({
  width: "9px",
  height: "9px",
  borderRadius: "999px",
  flexShrink: 0,
  background: $tone === "neutral" ? theme.color.status.completed.dot : theme.color.status[pillStatusTone[$tone]].dot
}));

const Caret = styled.span({ fontSize: "9px", opacity: 0.7 });

const Popover = styled.div(({ theme }) => ({
  position: "absolute",
  right: 0,
  top: "calc(100% + 8px)",
  width: "min(380px, 88vw)",
  zIndex: 40,
  display: "grid",
  gap: theme.space.xl,
  border: `1px solid ${theme.color.borderStrong}`,
  borderRadius: theme.radius.card,
  background: theme.color.surface,
  boxShadow: "0 18px 40px -18px rgba(23, 33, 29, 0.45)",
  padding: theme.space.lg,
  textAlign: "left"
}));

const GroupTitle = styled.p(({ theme }) => ({
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  margin: `0 0 ${theme.space.sm}`,
  color: theme.color.textSubtle,
  fontSize: "10px",
  fontWeight: theme.font.weight.semibold,
  letterSpacing: "0.06em",
  textTransform: "uppercase"
}));

const ClearButton = styled.button(({ theme }) => ({
  border: 0,
  background: "none",
  padding: 0,
  color: theme.color.accent,
  fontSize: theme.font.size.sm,
  fontWeight: theme.font.weight.semibold,
  letterSpacing: "normal",
  textTransform: "none",
  cursor: "pointer",
  "&:hover": { textDecoration: "underline" },
  "&:focus-visible": { outline: `3px solid ${theme.color.accentBg}`, outlineOffset: "2px" }
}));

const StatusRows = styled.div(({ theme }) => ({ display: "grid", gap: theme.space.md }));

const SystemDot = styled.span<{ $offline: boolean }>(({ theme, $offline }) => ({
  width: "8px",
  height: "8px",
  flexShrink: 0,
  borderRadius: "999px",
  background: $offline ? theme.color.status.failed.dot : theme.color.status.completed.dot
}));

const NoticeList = styled.div(({ theme }) => ({ display: "grid", gap: theme.space.md }));

const NoticeItem = styled.article<{ $tone: StatusTone }>(({ theme, $tone }) => ({
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  gap: theme.space.md,
  alignItems: "start",
  border: `1px solid ${theme.color.status[$tone].border}`,
  borderRadius: theme.radius.md,
  background: theme.color.status[$tone].bg,
  padding: `${theme.space.md} ${theme.space.lg}`,
  "& h3": { margin: 0, fontSize: theme.font.size.md },
  "& p": { margin: `${theme.space.xs} 0 0`, color: theme.color.textMuted, fontSize: theme.font.size.sm }
}));

const FeedList = styled.div(({ theme }) => ({ display: "grid", gap: theme.space.xs }));

const FeedItem = styled.div<{ $unread: boolean }>(({ theme, $unread }) => ({
  display: "grid",
  gridTemplateColumns: "8px minmax(0, 1fr) auto auto",
  gap: theme.space.md,
  alignItems: "center",
  borderRadius: theme.radius.sm,
  background: $unread ? theme.color.accentBg : "transparent",
  padding: `${theme.space.xs} ${theme.space.sm}`,
  fontSize: theme.font.size.sm,
  color: theme.color.text,
  "& time": { color: theme.color.textSubtle, fontSize: theme.font.size.xs, whiteSpace: "nowrap" }
}));

const FeedDot = styled.span<{ $tone: StatusTone }>(({ theme, $tone }) => ({
  width: "7px",
  height: "7px",
  borderRadius: "999px",
  background: theme.color.status[$tone].dot
}));

const EmptyLine = styled.p(({ theme }) => ({
  margin: 0,
  padding: `${theme.space.xs} ${theme.space.sm}`,
  color: theme.color.textSubtle,
  fontSize: theme.font.size.sm
}));

interface StatusPillProps {
  /** Whether the first refresh has landed; until then the pre-load defaults are
   * placeholders, so the pill shows a neutral "Checking status" instead of a
   * false "All clear". */
  loaded: boolean;
  notices: ConsoleNotice[];
  notifications: UiNotification[];
  /** Live system/model status, relocated here from the sidebar. Omitted (e.g.
   * before the first refresh) hides the System group. */
  system?: SystemStatus;
  /** Called when the popover opens — the provider marks notifications read. */
  onOpen: () => void;
  onDismissNotification: (id: number) => void;
  onClearNotifications: () => void;
}

// The console's one always-mounted notification surface: a severity-coloured
// pill in the topbar that opens an anchored popover with the persistent system
// notices ("Needs attention") and the recent action feedback ("Recent").
// Constant footprint + overlay popover = no layout shift, by construction.
export function StatusPill({
  loaded,
  notices,
  notifications,
  system,
  onOpen,
  onDismissNotification,
  onClearNotifications
}: StatusPillProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);

  const summary = loaded ? pillSummary(notices, notifications) : { label: "Checking status", tone: "neutral" as const };

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (anchorRef.current && event.target instanceof Node && !anchorRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function toggle() {
    setOpen((current) => {
      const next = !current;
      if (next) {
        onOpen();
      }
      return next;
    });
  }

  return (
    <Anchor ref={anchorRef}>
      <Pill
        $tone={summary.tone}
        data-tone={summary.tone}
        aria-expanded={open}
        aria-haspopup="dialog"
        type="button"
        onClick={toggle}
      >
        <PillDot $tone={summary.tone} aria-hidden="true" />
        {summary.label}
        <Caret aria-hidden="true">▾</Caret>
      </Pill>
      {open ? (
        <Popover role="dialog" aria-label="Notifications">
          {system ? (
            <section>
              <GroupTitle>System</GroupTitle>
              <StatusRows>
                <StatusRow
                  label="API"
                  value={system.apiOnline ? "Online" : "Offline"}
                  leading={<SystemDot $offline={!system.apiOnline} aria-hidden="true" />}
                />
                <StatusRow label="Provider" value={system.provider} />
                {system.chatModel ? (
                  <StatusRow
                    label="Chat"
                    value={system.chatHost ? `${system.chatModel} (${system.chatHost})` : system.chatModel}
                  />
                ) : null}
                {system.embeddingModel ? (
                  <StatusRow
                    label="Embedding"
                    value={
                      system.embeddingHost
                        ? `${system.embeddingModel} (${system.embeddingHost})`
                        : system.embeddingModel
                    }
                  />
                ) : null}
                <StatusRow label="Retrieval" value={system.retrieval} title={system.retrievalReason} />
                <BuildStatus />
              </StatusRows>
            </section>
          ) : null}
          <section>
            <GroupTitle>Needs attention</GroupTitle>
            {notices.length === 0 ? (
              <EmptyLine>Nothing needs attention.</EmptyLine>
            ) : (
              <NoticeList>
                {notices.map((notice) => (
                  <NoticeItem $tone={noticeStatusTone[notice.tone]} data-tone={notice.tone} key={notice.id}>
                    <div>
                      <h3>{notice.title}</h3>
                      <p>{notice.body}</p>
                    </div>
                    {notice.action && notice.actionLabel ? (
                      <Chip onClick={notice.action}>{notice.actionLabel}</Chip>
                    ) : null}
                  </NoticeItem>
                ))}
              </NoticeList>
            )}
          </section>
          <section>
            <GroupTitle>
              Recent
              {notifications.length > 0 ? <ClearButton onClick={onClearNotifications}>Clear</ClearButton> : null}
            </GroupTitle>
            {notifications.length === 0 ? (
              <EmptyLine>No recent notifications.</EmptyLine>
            ) : (
              <FeedList>
                {notifications.map((notification) => (
                  <FeedItem $unread={!notification.read} data-unread={!notification.read} key={notification.id}>
                    <FeedDot $tone={notificationStatusTone[notification.tone]} aria-hidden="true" />
                    <span>{notification.text}</span>
                    <time dateTime={notification.at}>{new Date(notification.at).toLocaleTimeString()}</time>
                    <IconButton
                      label="Dismiss notification"
                      size="sm"
                      onClick={() => onDismissNotification(notification.id)}
                    >
                      ✕
                    </IconButton>
                  </FeedItem>
                ))}
              </FeedList>
            )}
          </section>
        </Popover>
      ) : null}
    </Anchor>
  );
}
