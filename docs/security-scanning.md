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

## Maintaining this

- Dependabot PRs are labelled `dependencies`; minor/patch npm updates are grouped
  into a single PR to keep review noise down.
- To make a report-only scanner blocking, change its `exit-code` from `"0"` to
  `"1"` after confirming the current baseline is clean.
