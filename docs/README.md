# Markdown Magpie — Product Specs

This directory is the **authoritative, living specification** of how Markdown Magpie
works. These documents are the source of truth: they describe current behaviour, and
they are the thing you change *first* when you want behaviour to change. The intended
loop is:

> **Edit the spec → an agent (or a human) makes the code match it → the tests pin it.**

As-built and intended behaviour are meant to be **identical** here. When they diverge,
that is a bug in the code or a not-yet-done spec change — never a spec that is merely
"aspirational prose". If you are about to describe something the code does not yet do,
mark that clause (see *Conventions* below) so the gap is explicit and trackable.

## What this is NOT

`docs/superpowers/specs/` holds **design history** — dated, point-in-time design
records (`YYYY-MM-DD-*-design.md`) written to get a change approved and built, paired
with implementation plans in `docs/superpowers/plans/`. They are written in future
tense ("we will…"), anchored to PR numbers and branch names, and they *accrete*: several
subsystems have 3–4 overlapping design docs, and you must read the whole chain to find
the end state. They are excellent for **"why was this built this way"** and useless as
**"how does the system behave now"**. Treat them as an append-only archive; cite them
from a living spec as provenance, never the reverse.

## Conventions

Every spec in this set follows the same shape so a change to one clause maps cleanly to
one area of code:

- **Present-tense and normative.** "The API enqueues a job", not "we will enqueue".
  Requirement clauses use **MUST / MUST NOT / SHOULD / MAY** (RFC 2119 sense).
- **Stable clause IDs.** Normative clauses are numbered `R1`, `R2`, … within a spec.
  Reference them from tests, PRs, and other specs (e.g. `retrieval.md#R4`). Never
  renumber an existing clause — append new ones and strike (~~R7~~ *withdrawn*) retired
  ones, so external references never rot.
- **Code map.** Each spec ends with a **Code map** pointing at the files that implement
  it, so "edit spec → change code" has an unambiguous target.
- **Provenance.** Each spec links the design docs it consolidates, for the "why".
- **Gap markers.** A clause describing behaviour the code does **not** yet satisfy is
  tagged `> ⚠️ NOT YET IMPLEMENTED` with a one-line note. No untagged clause may be
  aspirational — an untagged clause is a claim about current behaviour and must be true.

See [`retrieval.md`](./retrieval.md) for the reference example of this shape.

## The spec set

Backbone specs are organised **by subsystem** (each authoritative for one code area);
a small number of **pipeline** specs describe the end-to-end flows that thread through
several subsystems.

### Pipeline (end-to-end)

- **[architecture.md](./architecture.md)** — system overview, boundaries, and the
  primary question → answer → gap → proposal → publish → verify-closure flow. Delegates
  subsystem detail to the specs below.

### Subsystem specs

| Spec | Subsystem | Primary code |
| --- | --- | --- |
| [ingestion.md](./ingestion.md) | Markdown ingestion & indexing | `apps/api` stores, `packages/markdown` |
| [retrieval.md](./retrieval.md) | Retrieval & answering (agentic loop, hybrid search, flow routing) | `apps/api/src/features/{ask,retrieve,route}`, `packages/retrieval` |
| gaps-and-maintenance.md *(planned)* | Knowledge gaps, clustering, the reconciler & patrols | `apps/api/src/scheduling`, `question-logging.md` |
| proposals-and-publishing.md *(planned)* | Draft → reconcile gate → provenance → publish → stale-PR regen | `apps/api/src/features/proposals`, `packages/git` |
| source-sync.md *(planned)* | Source-change sync to proposals | `apps/api/src/features/source-sync` |
| flows-and-seeding.md *(planned)* | Flows, seed plans, self-seeding | `apps/api/src/features/{seed,config}` |
| [questionnaires.md](./questionnaires.md) | Questionnaire mode & trust | `apps/api/src/features/questionnaires` |
| [ai-jobs.md](./ai-jobs.md) | Queue-only AI job contract & capability model | `packages/jobs`, `apps/watcher` |
| [api.md](./api.md) | HTTP API reference | `apps/api/src/**/routes.ts` |
| [mcp.md](./mcp.md) | MCP server | `apps/mcp` |
| [authorization.md](./authorization.md) | AuthN/Z & delegation | `packages/auth`, `apps/api/src/auth` |
| [rate-limiting.md](./rate-limiting.md) | Rate limits & AI cost controls | `apps/api/src/http`, `apps/api/src/platform` |
| observability.md *(planned)* | Logging, tracing, metrics, health | `packages/{logger,telemetry}` |
| [insights-charts.md](./insights-charts.md) | Insights & charts | `apps/web` insights, `apps/api` insights |
| [threat-model.md](./threat-model.md) | Prompt-injection threat model & the review gate | cross-cutting |

Rows without a link are specs not yet elevated from `architecture.md` / the design
archive — see the migration checklist below.

## Migration status

The whole doc set has been elevated into the living-spec shape. `retrieval.md` is the
reference exemplar; the checklist below is the record of that migration.

- [x] Spec index & conventions (this file)
- [x] `retrieval.md` — exemplar (as-built, code-mapped)
- [x] `gaps-and-maintenance.md` — extracted from `architecture.md` (as-built, code-mapped)
- [x] `proposals-and-publishing.md` — extracted from `architecture.md` (as-built, code-mapped)
- [x] `source-sync.md` — consolidated the source-sync design docs (as-built, code-mapped)
- [x] `flows-and-seeding.md` — consolidated the seeding design docs (as-built, code-mapped)
- [x] `observability.md` — extracted from `architecture.md` (as-built, code-mapped)
- [x] Converted the existing living docs (`ingestion`, `ai-jobs`, `api`, `mcp`,
      `authorization`, `rate-limiting`, `questionnaires`, `insights-charts`,
      `threat-model`) to the clause-ID + code-map convention
- [x] Slimmed `architecture.md` to overview + pipeline, delegating detail to subsystem specs
