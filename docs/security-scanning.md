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
| `@hono/node-server: ^2.0.11` | GHSA-frvp-7c67-39w9 | `@modelcontextprotocol/node` declares `^1.19.9`, and the path-traversal fix only exists in 2.x. It only imports `getRequestListener`, whose signature is identical in 1.x and 2.x, and `apps/api` already runs 2.x directly. | `@modelcontextprotocol/node` moves to `@hono/node-server` 2.x. |
| `minimatch: ^10.0.3` | GHSA-mh99-v99m-4gvg (via `brace-expansion`) | `archiver` (from `testcontainers`) reaches `brace-expansion` 2.x through `glob@10` and `readdir-glob@1`; only `brace-expansion >= 5.0.8` is patched, and its named-export shape is incompatible with `minimatch` 5/9, so the fix has to come from `minimatch` 10. | `testcontainers` ships an `archiver` whose glob chain uses `minimatch >= 10.0.3`. |

npm will not re-resolve an already-satisfied lockfile entry just because an
override was added — a stale entry survives even `rm -rf node_modules`. If
`npm ls <pkg>` reports `invalid: "<spec>" ... overridden`, delete that package's
entry from `package-lock.json` and re-run `npm install` so it resolves afresh.

Overrides on a package we also depend on directly must use the *same* spec as the
direct dependency, otherwise npm ignores the override silently — that is why
`apps/api` declares `@hono/node-server: ^2.0.11` rather than a looser range.

## Maintaining this

- Dependabot PRs are labelled `dependencies`; minor/patch npm updates are grouped
  into a single PR to keep review noise down.
- To make a report-only scanner blocking, change its `exit-code` from `"0"` to
  `"1"` after confirming the current baseline is clean.
- The `audit` job only gates on runtime dependencies (`--omit=dev`), but a plain
  `npm audit` over the whole tree is clean too. Keep it that way — reach for an
  `overrides` entry and document it above when an advisory has no direct fix.
