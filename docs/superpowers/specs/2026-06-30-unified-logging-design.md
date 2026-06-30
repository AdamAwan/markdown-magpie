# Unified Logging Design

## Goal

Persist and query all service logs from one place on the deployed box, with
cross-service correlation by `requestId`/`jobId`. The [structured logging
work](2026-06-30-structured-logging-design.md) (PR #64) already made every app
emit structured JSON on stdout with a `service` field and numeric pino levels;
it deliberately left "the aggregator itself" out of scope as an infrastructure
concern. This is that follow-up.

The target is the **deployed Docker host** (the staging box, and prod once it
follows the same shape) — not local dev. The unified view must be queryable
*after the fact*, which is what structured JSON buys us.

This requires **zero app-code changes**: pino already emits the JSON the
aggregator ingests (`{ level, time, pid, hostname, service, msg, ... }`, plus
`requestId`/`jobId` on request/job child loggers).

## Decisions

Settled during brainstorming:

- **Self-hosted, in the compose stack.** No data leaves the box, no per-GB bill.
  Three small containers added to `docker-compose.yml`. Rejected SaaS (Grafana
  Cloud / Datadog / etc.) to stay dependency-light and keep logs on-box.
- **Stack: Loki + Alloy + Grafana.** Loki stores/queries; Alloy collects from the
  Docker socket; Grafana is the UI. Alloy (not Promtail) is the collector —
  Promtail is in maintenance/EOL and Alloy is Grafana's current recommendation.
- **Grafana access: anonymous read-only, published port.** The box is on a
  trusted network; no login friction. (`GF_AUTH_ANONYMOUS_ENABLED=true`,
  `ORG_ROLE=Viewer`, login form disabled.)
- **Retention: 7 days.** Lean disk footprint, covers "what just broke"
  debugging. Enforced by Loki's compactor so it self-prunes.

## Architecture

Three containers added to `docker-compose.yml` under a **new `logging` profile**,
so local dev (`run-magpie`) is not forced to run them. Staging/prod brings the
whole stack up with `--profile app --profile logging`.

```
container stdout/stderr → Docker logs → Alloy (discover + tail + parse) → Loki (store 7d) → Grafana (LogQL)
```

### Loki

- Image: `grafana/loki` (pinned to a specific version tag, not `latest`).
- Monolithic single-binary mode, filesystem storage on a named volume
  (`loki-data`), TSDB schema (current default).
- **Not published** — only Alloy (push) and Grafana (query) reach it on the
  compose network.
- Retention 7 days: `limits_config.retention_period: 168h`, compactor with
  `retention_enabled: true` and `delete_request_store: filesystem`.
- Config mounted from `deploy/logging/loki-config.yaml`.

### Alloy

- Image: `grafana/alloy` (pinned).
- Mounts `/var/run/docker.sock` **read-only** for discovery, plus the
  container-log directory it needs to tail.
- Config (`deploy/logging/alloy/config.alloy`) pipeline:
  1. `discovery.docker` — list running containers.
  2. `discovery.relabel` — derive the `service` label from the compose service
     name label (`com.docker.compose.service`); keep `container` as a label too.
  3. `loki.source.docker` — tail each container's stdout/stderr.
  4. `loki.process` with a JSON stage — parse pino lines: map the numeric pino
     `level` (30→`info`, 40→`warn`, 50→`error`, 20→`debug`, 60→`fatal`, 10→
     `trace`) to a `level` label, and surface `msg` as the log line. Keep
     `requestId`/`jobId` as **parsed fields, not labels** — they are
     high-cardinality and promoting them to labels would blow up Loki's index;
     they stay queryable via LogQL `| json`.
  5. `loki.write` — push to Loki's compose-network address.
- **Non-JSON lines** (postgres, migrate, any pino-pretty dev output) must pass
  through unparsed rather than erroring — they still get the `service`/`container`
  labels and are searchable, just without parsed fields.

### Grafana

- Image: `grafana/grafana` (pinned).
- Loki datasource pre-provisioned via
  `deploy/logging/grafana/provisioning/datasources/loki.yaml` (points at the
  Loki container on the compose network, set as default).
- Anonymous read-only auth via environment:
  `GF_AUTH_ANONYMOUS_ENABLED=true`, `GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer`,
  `GF_AUTH_DISABLE_LOGIN_FORM=true`.
- Published on host port **3001** (3000=web, 4000=api, 4001=mcp-http, 5432=pg are
  taken); container listens on its default 3000 → `3001:3000`.
- Named volume (`grafana-data`) for its own state.

## Correlation in practice

Pino request/job child loggers already bind `requestId` (api request middleware)
and `jobId` (watcher `WorkerLoop.execute`). In Grafana's Explore view:

- Filter one service: `{service="api"} | json | requestId="abc123"`.
- Follow an id across services: drop the `service` selector —
  `{job="docker"} | json | requestId="abc123"` — to see api → watcher → mcp lines
  for the same request/job interleaved by time.
- Errors only: `{service="watcher", level="error"}`.

## Files

```
deploy/logging/
  loki-config.yaml
  alloy/config.alloy
  grafana/provisioning/datasources/loki.yaml
```

`docker-compose.yml` gains `loki`, `alloy`, `grafana` services (profile
`logging`) and the `loki-data` / `grafana-data` volumes.

## Verification

This is infrastructure/config — there are no unit tests. Verification is a
manual end-to-end pass on the running stack:

1. `docker compose --profile app --profile logging up` (with a provider set).
2. Generate traffic via the `run-magpie` flow (hit the api, let the watcher run a
   job).
3. In Grafana (`http://<host>:3001`, no login):
   - All services appear as selectable `service` label values (api, web, watcher,
     mcp-http, postgres, migrate).
   - `{service="api", level="error"}` and a `level` filter work — i.e. pino's
     numeric level was mapped to a name.
   - A single `requestId` (or `jobId`) correlates lines across more than one
     service.

## Scope guardrails

- **No app-code changes.** The apps already emit the JSON this ingests. If
  verification reveals a field gap, that is a separate change.
- Compose only — no host-level Docker plugin install (keeps it "just compose").
- Out of scope: dashboards beyond the provisioned datasource, alerting,
  metrics/traces, SaaS shipping, and authenticated/multi-user Grafana.
- Pin all three images to explicit version tags (no `latest`), consistent with
  `pgvector/pgvector:pg16` in the existing compose.

## Work breakdown (high level)

1. Add `deploy/logging/loki-config.yaml` (single-binary, filesystem, 7d
   retention via compactor).
2. Add `deploy/logging/alloy/config.alloy` (docker discovery → relabel → JSON
   parse + level mapping → write to Loki).
3. Add `deploy/logging/grafana/provisioning/datasources/loki.yaml`.
4. Add `loki`, `alloy`, `grafana` services + volumes to `docker-compose.yml`
   under the `logging` profile.
5. Verify end-to-end against the running stack.
