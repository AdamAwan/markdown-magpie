// The single source of truth for a repository's primary branch — the branch a
// proposal is based on, the pull-request base, and the branch a local-git proposal
// merges into. Every code path resolves it here so create, publish, merge, and
// reject can never disagree (which previously produced master-vs-main failures).
//
// Precedence, highest first:
//   1. configuredBranch — the admin-authored config `branch`, authoritative when set
//   2. detectedDefault  — origin/HEAD symbolic-ref
//   3. detectedCurrent  — git branch --show-current
//   4. "main"           — last-resort default
export function resolvePrimaryBranch(inputs: {
  configuredBranch?: string;
  detectedDefault?: string;
  detectedCurrent?: string;
}): string {
  return (
    nonEmpty(inputs.configuredBranch) ?? nonEmpty(inputs.detectedDefault) ?? nonEmpty(inputs.detectedCurrent) ?? "main"
  );
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
