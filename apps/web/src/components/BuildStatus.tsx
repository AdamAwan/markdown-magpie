"use client";

import { useEffect, useState } from "react";
import styled from "@emotion/styled";
import { apiGet } from "../lib/api";
import { shortSha } from "../lib/format";
import { BuildInfo } from "../lib/types";

const StatusGroup = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.md
}));

const StatusGroupTitle = styled.p(({ theme }) => ({
  margin: 0,
  color: theme.color.textSubtle,
  fontSize: theme.font.size.xs,
  fontWeight: theme.font.weight.semibold,
  letterSpacing: "0.06em"
}));

const StatusLine = styled.div(({ theme }) => ({
  display: "flex",
  flexDirection: "column",
  gap: theme.space.xs,
  color: theme.color.textMuted,
  fontSize: theme.font.size.sm,
  fontWeight: theme.font.weight.medium,
  "& span:first-of-type": {
    color: theme.color.textMuted,
    fontSize: theme.font.size.xs,
    fontWeight: theme.font.weight.semibold
  },
  "& span:last-of-type": {
    display: "flex",
    alignItems: "center",
    gap: theme.space.sm,
    color: theme.color.text,
    fontWeight: theme.font.weight.medium
  }
}));

// Sidebar "Build" group showing which commit is live. The build identity is
// static for the life of the process, so it's fetched once on mount rather than
// folded into the 4s console poll. When the API reports no build info (an image
// built without the CI build args, or local dev) it shows a "Development" build.
export function BuildStatus() {
  const [build, setBuild] = useState<BuildInfo | undefined>();

  useEffect(() => {
    const controller = new AbortController();
    apiGet<BuildInfo>("/version", { signal: controller.signal })
      .then(setBuild)
      .catch(() => {
        // Leave it unset; the API status line already surfaces connectivity.
      });
    return () => controller.abort();
  }, []);

  if (!build) {
    return null;
  }

  const committed = build.committedAt ? new Date(build.committedAt) : null;
  const committedValid = committed && !Number.isNaN(committed.getTime());

  return (
    <StatusGroup>
      <StatusGroupTitle>Build</StatusGroupTitle>
      {build.sha ? (
        <>
          <StatusLine>
            <span>Commit</span>
            <span title={build.commitMessage ?? undefined}>{shortSha(build.sha)}</span>
          </StatusLine>
          <StatusLine>
            <span>Deployed</span>
            <span>{committedValid ? committed.toLocaleString() : "Unknown"}</span>
          </StatusLine>
        </>
      ) : (
        <StatusLine>
          <span>Version</span>
          <span>Development</span>
        </StatusLine>
      )}
    </StatusGroup>
  );
}
