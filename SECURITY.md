# Security Policy

## Reporting a vulnerability

Please report suspected security vulnerabilities **privately** — do not open a
public issue for a security report.

- Use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
  ("Report a vulnerability" under the repository **Security** tab), or
- email the maintainers directly.

Include a description of the issue, the affected component (`api`, `watcher`,
`web`, `mcp`, or a `packages/*` library), and steps to reproduce. We aim to
acknowledge a report within a few business days.

## Supported versions

This project ships from `main`; security fixes land there. There is no separate
long-term-support branch. Deployments should track the latest published
container image.

## Scope and known controls

Markdown Magpie feeds untrusted document and question text to language models
and turns the result into proposed documentation changes. The prompt-injection
threat model and the controls that mitigate it (argv-only CLI invocation,
checkout-scoped writes, a database-sandboxed watcher, and a mandatory
human-review gate before publication) are documented in
[docs/threat-model.md](docs/threat-model.md).

Deployment, transport, and authentication hardening expectations for operators
are documented in [docs/security-review.md](docs/security-review.md) and the
[Authentication](README.md#authentication) section of the README.

## Automated security scanning

The repository runs automated scanning on every pull request, on pushes to
`main`, and weekly (see [docs/security-scanning.md](docs/security-scanning.md)):

- Dependency vulnerabilities — `npm audit` (gating on high/critical)
- Committed secrets — gitleaks (gating)
- Container image CVEs — Trivy (report-only, uploaded to the Security tab)
- Dockerfile / compose misconfiguration — Trivy config scan (report-only)
- Dependency updates — Dependabot (weekly)
