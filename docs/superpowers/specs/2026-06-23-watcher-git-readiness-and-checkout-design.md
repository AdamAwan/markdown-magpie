# Watcher Git Readiness and Local Checkout Design

## Problem

Publication jobs run Git inside the watcher, but the watcher currently advertises
the `github` capability based only on credentials and author identity. It also
uses repository filesystem paths supplied by the API. Those paths are valid on
the API host, but a standalone watcher on another host has its own checkout
volume. A missing watcher-local checkout is surfaced by Node as `spawn git
ENOENT`, the same terse error produced for a missing Git executable.

## Design

### Git executable readiness

The watcher will probe `git --version` when deriving runtime capabilities. The
`github` capability is ready only when:

- `GITHUB_TOKEN` is set;
- `MAGPIE_GIT_AUTHOR_NAME` is set;
- `MAGPIE_GIT_AUTHOR_EMAIL` is set; and
- the Git probe succeeds.

Startup logging will report Git executable readiness without exposing secrets.
The probe dependency will be injectable so unit tests can cover available and
missing Git without depending on the test host.

### Watcher-local checkout preparation

Before publishing a proposal, crunch changeset, or source-sync changeset, the
publication runner will prepare the destination repository with the existing
`ensureGitCheckout` helper. It will use:

- the repository ID for the stable checkout directory name;
- `repository.remoteUrl`, falling back to `repository.git.remoteUrl`;
- `repository.defaultBranch`; and
- `MAGPIE_CHECKOUT_ROOT`, falling back to `.magpie/checkouts`.

The prepared `RepositoryRef` will replace API-host-specific `localPath`,
`git.workTreeRoot`, and `git.indexedPath` values with paths rooted in the
watcher's checkout. It will preserve `git.relativePathFromRoot`, ensuring a
destination configured as a repository subdirectory still publishes beneath
that subdirectory.

If no remote URL is available, publication will fail with an explicit
configuration error. Clone, fetch, authentication, and remote consistency
remain owned by `ensureGitCheckout`.

## Boundaries

The API execution-context contract remains unchanged for compatibility. The
watcher treats API filesystem paths as descriptive context only and never as a
path it can assume exists locally. No shared filesystem between API and watcher
hosts is required.

The Git readiness probe prevents a watcher without Git from claiming any
`github` jobs, including pull-request refresh jobs. This matches the current
single capability boundary; splitting Git publication from GitHub API polling
is outside this change.

## Testing

Capability tests will verify that complete GitHub configuration advertises the
capability only when the injected Git probe succeeds. Runner tests will verify
that all three publication flows prepare a checkout before publishing and pass
the watcher-local repository paths to the publisher. Existing watcher tests,
type checking, and builds will remain green.
