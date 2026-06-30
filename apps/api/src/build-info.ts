// Identity of the running build, surfaced at GET /api/version so the console can
// show which commit is live. The values are baked into the image at build time
// (see the Dockerfile ARG/ENV and .github/workflows/publish-image.yml), so a
// process started from a published image reports the exact deployed commit.
// Running locally (npm run dev, or an image built without the args) leaves these
// unset, in which case every field is null and the console shows a "dev" build.
export interface BuildInfo {
  // Short git SHA of the deployed commit.
  sha: string | null;
  // First line of that commit's message.
  commitMessage: string | null;
  // ISO-8601 timestamp of when the commit landed on main (its committer date,
  // i.e. the merge time).
  committedAt: string | null;
}

function readEnv(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function getBuildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  return {
    sha: readEnv(env.MAGPIE_BUILD_SHA),
    commitMessage: readEnv(env.MAGPIE_BUILD_COMMIT_MESSAGE),
    committedAt: readEnv(env.MAGPIE_BUILD_COMMITTED_AT)
  };
}
