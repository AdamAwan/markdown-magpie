"use client";

import { useEffect, useState } from "react";
import { apiGet } from "../lib/api";
import { shortSha } from "../lib/format";
import { BuildInfo } from "../lib/types";

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
    <div className="statusGroup">
      <p className="statusGroupTitle">Build</p>
      {build.sha ? (
        <>
          <div className="statusLine">
            <span>Commit</span>
            <span title={build.commitMessage ?? undefined}>{shortSha(build.sha)}</span>
          </div>
          <div className="statusLine">
            <span>Deployed</span>
            <span>{committedValid ? committed.toLocaleString() : "Unknown"}</span>
          </div>
        </>
      ) : (
        <div className="statusLine">
          <span>Version</span>
          <span>Development</span>
        </div>
      )}
    </div>
  );
}
