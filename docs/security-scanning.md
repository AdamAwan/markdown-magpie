# Security scanning

This repo layers automated security scanning on top of the functional CI in
[`.github/workflows/verify.yml`](../.github/workflows/verify.yml). The scanners
are preventative — at the time they were added a manual `npm audit --omit=dev`
reported zero vulnerabilities — so their job is to catch regressions and
newly-disclosed advisories, not to fix an active issue.

## What runs where

| Concern | Tooling | Location |
| --- | --- | --- |
| Dependency updates | Dependabot (npm + github-actions, weekly) | [`.github/dependabot.yml`](../.github/dependabot.yml) |
| Merging low-risk dependency updates | GitHub native auto-merge, enabled for Dependabot patch/minor PRs | [`dependabot-auto-merge.yml`](../.github/workflows/dependabot-auto-merge.yml) |
| Dependency vulnerabilities | `npm audit --omit=dev --audit-level=high` | `audit` job in [`security.yml`](../.github/workflows/security.yml) |
| Committed secrets | gitleaks | `secret-scan` job in `security.yml` |
| IaC / Dockerfile misconfig | Trivy config scan | `config-scan` job in `security.yml` |
| Container image CVEs | Trivy image scan → SARIF | [`publish-image.yml`](../.github/workflows/publish-image.yml) |

The `security.yml` workflow runs on every pull request, on pushes to `main`, and
on a weekly schedule (the schedule catches advisories disclosed after a PR has
already merged). It is a separate workflow from Verify so that a scanner outage
or a fresh advisory never blocks the core typecheck/test/lint/build gates.

## Report-only vs. gating

- **Gating (fails the build):** `npm audit` on a HIGH/CRITICAL runtime advisory,
  and gitleaks on a detected secret.
- **Report-only (surfaces, does not fail):** the Trivy config scan and the Trivy
  image scan. Both use `exit-code: "0"` today because they need a clean baseline
  before they can gate without false-positive churn. The image scan uploads its
  findings to the repository **Security** tab (SARIF). Flip `exit-code` to `1`
  once the baselines are clean to make them blocking.

## Container image scan flow

`publish-image.yml` builds and pushes the image, then scans the exact
`sha-<shortsha>` tag it just produced with Trivy (`ignore-unfixed: true`, so only
actionable CVEs are reported). This runs only when an image was actually pushed —
there is nothing to scan on a pull request or a no-push manual dispatch. Because
the deploy workflow (`deploy.yml`) consumes images published here, this puts a
vulnerability report in front of every image that can be deployed.

## Dependabot auto-merge

Dependency bumps were a large share of the commit history and several were merged by
hand. [`dependabot-auto-merge.yml`](../.github/workflows/dependabot-auto-merge.yml) removes
the hand-merging for the low-risk ones.

**What it does.** On every Dependabot pull request it reads the update metadata
(`dependabot/fetch-metadata`, pinned to a commit SHA) and, when the update is a semver
**patch** or **minor**, runs `gh pr merge --auto --squash`. That command does not merge
anything: it switches on GitHub's native auto-merge for the PR, and GitHub performs the
squash merge later, once the base branch's requirements are met.

**What it never does.**

- It never merges directly, and it never approves a pull request.
- It never acts on a semver-**major** update — those are left for a human. For a grouped
  PR the update type is the _highest_ bump in the group, so one major in a group holds
  the whole PR back.
- It never acts on a PR that was not opened by, or a run that was not triggered by,
  `dependabot[bot]`.
- It checks out and runs no code from the pull request. Its token is scoped to
  `contents: write` and `pull-requests: write` on that one job (the minimum the auto-merge
  API accepts); the workflow default is no permissions at all.

**Grouping.** `dependabot.yml` batches npm minor/patch updates into one weekly PR
(`dev-and-minor`) and all workflow-action updates into another (`actions`). Because the
workflows pin actions by major tag (`@v7`), the `actions` PR is usually a major bump and
therefore usually waits for a human.

### Required repository settings

The workflow is inert until the owner enables these, and **the second one is a safety
requirement, not a nicety**:

1. **Settings → General → Pull Requests → Allow auto-merge.** Without it the
   `gh pr merge --auto` step fails and nothing is merged.
2. **A branch protection rule (or ruleset) on `main` with "Require status checks to pass
   before merging"**, listing at least the Verify jobs — `Typecheck`, `Test`,
   `Golden Eval`, `Lint and Dead Code`, `Build` — and ideally the Security jobs
   (`Dependency audit`, `Secret scan`).

> ⚠️ **Without required status checks, auto-merge merges immediately.** Native auto-merge
> waits only for _required_ checks and reviews. If `main` has no required checks, GitHub
> has nothing to wait for and merges the pull request the moment auto-merge is enabled —
> before CI has finished, and whether or not it would have passed. Set up the required
> checks **first**, then turn on "Allow auto-merge". A check that is not marked required
> does not hold an auto-merge back even when it fails.

Things that follow from those settings:

- If the rule also **requires pull-request reviews**, auto-merge waits for a human
  approval. That is a reasonable policy, but it puts a click back on every update; this
  workflow deliberately does not auto-approve.
- If the rule **requires branches to be up to date**, a Dependabot PR that falls behind
  `main` stalls until it is rebased (`@dependabot rebase`, or Dependabot's own rebase on
  the next run).
- Pushing to a Dependabot branch by hand does not switch auto-merge back off. Disable it
  on the PR ("Disable auto-merge") before adding commits you want reviewed.

### What an auto-merge does _not_ trigger

GitHub does not start workflow runs for events caused by the workflow `GITHUB_TOKEN`, and
that includes the push to `main` made by an auto-merge this workflow enabled. So an
auto-merged dependency update does **not** run Verify on `main`, and therefore does not
publish a container image or trigger `deploy.yml`. The update ships with the next
human-merged change (whose Verify run builds `main` as a whole) or a manual
`workflow_dispatch` of the publish workflow.

That is the conservative default: no unattended production deploys from a bot's merge. To
make auto-merged updates build and deploy on their own, enable auto-merge with a GitHub App
installation token or a fine-grained PAT instead of `GITHUB_TOKEN` (set `GH_TOKEN` on the
merge step) — and accept that dependency updates then reach production without a human in
the loop.

### Semver is a convention, not a guarantee

A minor or patch release can still break things, and for `0.x` packages a minor bump is
allowed to be breaking. The required checks (typecheck, the full test suite against
Postgres, the golden-question eval, lint, build) are the actual gate — which is why they
must be _required_. If a class of package proves unsafe to auto-merge, exclude it from the
group in `dependabot.yml` or add an `ignore` rule rather than loosening the checks.

## npm `overrides`

Some advisories sit in a transitive dependency whose parent still pins the
vulnerable range, so there is nothing to bump in our own manifests. For those the
root [`package.json`](../package.json) carries an `overrides` entry that forces
the patched version across the whole tree. Each one is a liability — it pins a
version the parent has not tested against — so the table below records why it
exists and what has to be true before it can be dropped.

| Override | Advisory | Why it is needed | Drop it when |
| --- | --- | --- | --- |
| `postcss: ^8.5.18` | GHSA-qx2v-qp2m-jg93, GHSA-6g55-p6wh-862q, GHSA-r28c-9q8g-f849 | `next` pins `postcss` to an exact `8.4.31`. | `next` ships with `postcss >= 8.5.18`. |
| `sharp: ^0.35.0` | GHSA-f88m-g3jw-g9cj (libvips CVEs) | `next` declares `sharp: ^0.34.5`, and the fix is in the next minor. | `next` widens its `sharp` range to `>= 0.35.0`. |
| `@hono/node-server: ^2.1.8` | GHSA-frvp-7c67-39w9, GHSA-qv5m-9pm6-hqp3, GHSA-jpvv-r467-5p4w | `@modelcontextprotocol/node` declares `^1.19.9`, and the path-traversal fix only exists in 2.x. It only imports `getRequestListener`, whose signature is identical in 1.x and 2.x, and `apps/api` already runs 2.x directly. | `@modelcontextprotocol/node` moves to `@hono/node-server` 2.x. |
| `minimatch: ^10.0.3` | GHSA-mh99-v99m-4gvg (via `brace-expansion`) | `archiver` (from `testcontainers`) reaches `brace-expansion` 2.x through `glob@10` and `readdir-glob@1`; only `brace-expansion >= 5.0.8` is patched, and its named-export shape is incompatible with `minimatch` 5/9, so the fix has to come from `minimatch` 10. | `testcontainers` ships an `archiver` whose glob chain uses `minimatch >= 10.0.3`. |

npm will not re-resolve an already-satisfied lockfile entry just because an
override was added — a stale entry survives even `rm -rf node_modules`. If
`npm ls <pkg>` reports `invalid: "<spec>" ... overridden`, delete that package's
entry from `package-lock.json` and re-run `npm install` so it resolves afresh.

Overrides on a package we also depend on directly must use the *same* spec as the
direct dependency, otherwise npm ignores the override silently — that is why
`apps/api` declares `@hono/node-server: ^2.1.8`, matching the override. Bump both
together: when they drift apart the override stops applying and the transitive
copy under `@modelcontextprotocol/node` can stay on a vulnerable version.

## Maintaining this

- Dependabot PRs are labelled `dependencies`; minor/patch npm updates are grouped
  into a single PR, and workflow-action updates into another, to keep review noise down.
  Patch/minor PRs auto-merge once the required checks pass (see _Dependabot auto-merge_
  above); majors need a human.
- `dependabot/fetch-metadata` is pinned to a full commit SHA with the version in a trailing
  comment, because that workflow holds a write token. Dependabot keeps SHA pins current the
  same way it does tags. The other workflows still pin actions by major tag.
- To make a report-only scanner blocking, change its `exit-code` from `"0"` to
  `"1"` after confirming the current baseline is clean.
- The `audit` job only gates on runtime dependencies (`--omit=dev`), but a plain
  `npm audit` over the whole tree is clean too. Keep it that way — reach for an
  `overrides` entry and document it above when an advisory has no direct fix.
