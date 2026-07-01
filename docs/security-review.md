# Security review pack (for hosting / IT sign-off)

This document is written for a reviewer assessing Markdown Magpie for internal
hosting. It summarises what the application is, what data it handles and where
that data goes, the security controls already implemented, and the
operator-side hardening a production deployment must complete. It is a companion
to the [threat model](threat-model.md), [security-scanning](security-scanning.md),
and the [Authentication](../README.md#authentication) section of the README.

## 1. What the application is

Markdown Magpie indexes Markdown knowledge sources, answers questions with
citations, records weak answers, clusters recurring gaps, drafts Markdown
improvements, and opens pull requests for human review.

Components (all from one container image, selected by command):

| Component | Role | Network exposure |
| --- | --- | --- |
| `api` | HTTP API, owns the database and job queue | Serves the API (default port 4000) |
| `web` | Next.js review/admin console | Serves the UI (default port 3000) |
| `watcher` | Claims AI jobs, calls the provider, posts results back | Outbound only; no inbound app traffic (health port 4002) |
| `mcp` / `mcp-http` | MCP server surface over the API | Optional; stdio, or HTTP on 4001 |
| `postgres` | Application data + `pg-boss` job queue | Internal (see hardening below) |

Key architectural property: **the API never calls a chat/generative model
inline.** Generative work is queued; the watcher claims it, calls back to the
API over HTTP for scoped context, invokes the provider, and posts the result
back. The watcher has **no database access**. This bounds the blast radius of a
compromised or prompt-injected model — see [threat-model.md](threat-model.md).

## 2. Data handled and data flows

**The application is provider- and infrastructure-neutral and imposes no data
egress of its own.** Where data is stored and where it is sent are determined
entirely by operator configuration, not by the app. The app requires **Postgres**
as its datastore, but *where* Postgres runs (local, self-hosted, or a managed
service) is the hoster's choice. Likewise, the app calls whichever AI provider
the operator configures — it mandates no particular model or vendor. The sections
below describe *what* data exists and *which* configuration knobs govern its
storage and egress, so the hoster can align them with their own data-governance
policy.

### Stored in Postgres
- **Questions and answers** — the full text of user questions, generated
  answers, citations, and feedback. Questions are stored **without a user
  identifier** (anonymous by design; no `user_id`/email column).
- **Document sections and embeddings** — the indexed knowledge-base content and
  its vector embeddings.
- **Proposals, gap clusters, repositories, AI job records** — operational data.
  `ai_jobs` rows hold job input/output (question text and retrieved context) as
  JSONB.

The application does **not** implement field-level encryption; encryption at
rest is the responsibility of the hosting infrastructure (encrypted volume or a
managed database).

### Data leaving the deployment (egress)
When a question is answered (or a proposal drafted), the watcher sends the
following to the **configured AI provider**:

- the user's question text,
- retrieved Markdown sections (knowledge-base content),
- system prompts and flow metadata.

User identities, provider API keys, and Git remotes are **not** sent to the
model.

Provider options and their data-governance implications:

| `AI_PROVIDER` | Where data goes | Self-hostable? |
| --- | --- | --- |
| `openai-compatible` | Whatever `OPENAI_COMPATIBLE_BASE_URL` points at | **Yes** — point it at an in-house/self-hosted model (e.g. vLLM, Ollama) |
| `azure-openai` | Microsoft Azure (your tenant) | Private cloud; covered by your Azure agreement/DPA |
| `claude` | Anthropic API (via the Claude CLI) | No — public API |
| `codex` | Local subprocess (egress depends on the CLI's own backend) | Depends on the CLI |

> **Data-classification decision required.** If the indexed knowledge base
> contains proprietary or regulated content, select a self-hosted
> (`openai-compatible`) or contractually-covered (`azure-openai`) provider.
> This is the single most important governance decision for the deployment.

Git hosting (GitHub/GitLab/etc.) is the other egress: the app pushes branches
and opens pull requests to the configured destination repositories.

## 3. Controls already implemented

- **Authentication fails closed.** Auth is required unless `AUTH_REQUIRED` is set
  *exactly* to `false`; a blank/typo'd value keeps auth on. With auth required the
  API refuses to start unless Auth0 is configured with a real audience. The API,
  web app, and both MCP transports validate Auth0-issued JWTs.
- **Scoped authorization.** Routes enforce per-scope checks (`read:knowledge`,
  `manage:knowledge`, `manage:jobs`, `ask:knowledge`) that fail closed. The
  authorization model is currently flat — treat `manage:knowledge` as a
  privileged role (tracked in issue #88).
- **Mandatory human review of AI output.** No AI-generated content reaches a
  destination repository's default branch without a human merging a pull
  request. See [threat-model.md](threat-model.md) (control C4) and the operator
  requirements below.
- **Input handling.** Request bodies are validated with Zod schemas; all SQL is
  parameterized (no string concatenation); request bodies are capped at 4 MB.
- **Transport headers.** `secureHeaders()` sets `X-Content-Type-Options`,
  `X-Frame-Options`, `Referrer-Policy`, HSTS, and Cross-Origin isolation headers.
  CORS defaults to `*` but is restricted via `CORS_ALLOWED_ORIGINS`.
- **Hardened container.** Multi-stage build, runs as a non-root user
  (`uid 1001`), production-only dependencies (`npm prune --omit=dev`), pinned
  base image.
- **Supply-chain / CI.** Least-privilege workflow permissions, pinned actions,
  Dependabot, gitleaks secret scanning, `npm audit` gating on high/critical, and
  container image CVE scanning. Zero known production-dependency vulnerabilities
  at time of writing. See [security-scanning.md](security-scanning.md).
- **No secrets in the repository.** `.env` is gitignored; only placeholder
  templates (`.env.example`, `.env.compose.example`) are tracked, enforced by
  gitleaks.

## 4. Operator hardening checklist (before production)

These live in the deployment, not the application code, and **must** be
completed for a production/internal deployment:

- [ ] **Terminate TLS upstream.** The app serves plain HTTP; front it with a
      reverse proxy (nginx/Caddy/Traefik) doing TLS. HSTS is already emitted.
- [ ] **Do not publish internal ports.** In `docker-compose.yml`, Postgres
      (`5432`) and Grafana (`3001`) are published to the host by default. Keep
      them on the internal compose network; expose only the proxied web/API
      origin. Bind app ports to loopback behind the proxy.
- [ ] **Replace the default Postgres password.** The compose file ships
      `postgres/postgres` for local use. Use a strong generated credential, and
      prefer a managed database with encryption at rest and automated backups.
- [ ] **Lock down Grafana.** The logging profile enables anonymous Viewer access
      with the login form disabled. Put it behind authentication/SSO, or only run
      the `logging` profile on a trusted, non-exposed host.
- [ ] **Set `CORS_ALLOWED_ORIGINS`** to your web origin(s); do not ship the `*`
      default.
- [ ] **Configure Auth0 for real** (`AUTH_REQUIRED` unset/true, real
      `AUTH0_*`), wired to your corporate IdP, and grant `manage:knowledge` /
      `manage:jobs` narrowly.
- [ ] **Enable branch protection** on destination repositories: require human
      approval, disallow direct pushes, and ensure the bot account cannot
      approve/merge its own PRs. Never wire an auto-merge path for AI-authored
      PRs (this is the primary prompt-injection mitigation — see the threat
      model).
- [ ] **Choose a compliant AI provider** per the data-classification note in
      §2.
- [ ] **Manage secrets outside plaintext env files** where your environment
      requires it (Docker/K8s secrets, Vault, or a cloud secret manager).
- [ ] **Confirm log hygiene.** Request logs contain only `{status, durationMs}`.
      Keep provider log levels at INFO in production (DEBUG paths in the watcher
      are more verbose). Loki retains logs for 7 days by default.

## 5. Known gaps / roadmap

Tracked, not yet implemented — disclose these to reviewers:

- **No application-level rate limiting.** `POST /api/ask` enqueues billable AI
  jobs; an authenticated caller can flood the queue. A per-principal limiter is
  recommended (and belongs at the reverse proxy or in the API).
- **No data-retention policy for questions/answers.** Job records self-purge
  (14/30 days) and Loki logs purge at 7 days, but stored questions/answers
  accumulate indefinitely. Add a retention job matching your policy.
- **Flat authorization model** (issue #88): `manage:knowledge` is broad.
- **Report-only image/config scans.** Trivy scans are non-gating today
  (`exit-code: 0`); flip to gating once the baseline is clean.
- **No SAST / CodeQL** in CI, and **no license-compliance gate** (the project
  and its direct dependencies are MIT/Apache; transitive licenses are not
  scanned).
