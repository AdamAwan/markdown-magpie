"use client";

import { Fragment, useEffect, useState } from "react";
import { apiGet } from "../lib/api";
import { shortSha } from "../lib/format";
import { BuildInfo } from "../lib/types";
import { StatusRow } from "./common";

// The "Commit"/"Deployed" rows of the topbar status popover's System group,
// showing which commit is live. The build identity is static for the life of
// the process, so it's fetched once on mount rather than folded into the 4s
// console poll. When the API reports no build info (an image built without the
// CI build args, or local dev) it shows a "Development" build.
//
// Rendered inside the popover's shared status grid, so it emits bare StatusRow
// rows (a Fragment) rather than its own wrapper.
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

  if (!build.sha) {
    return <StatusRow label="Build" value="Development" />;
  }

  const committed = build.committedAt ? new Date(build.committedAt) : null;
  const committedValid = committed && !Number.isNaN(committed.getTime());

  return (
    <Fragment>
      <StatusRow label="Commit" value={shortSha(build.sha)} title={build.commitMessage ?? undefined} />
      <StatusRow label="Deployed" value={committedValid ? committed.toLocaleString() : "Unknown"} />
    </Fragment>
  );
}
