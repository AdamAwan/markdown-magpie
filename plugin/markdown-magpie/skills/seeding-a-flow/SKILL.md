---
name: seeding-a-flow
description: Propose and approve a source-grounded seed plan that drafts new knowledge documents into a Markdown Magpie flow, using kb_outline and kb_seed. Use when a flow is empty or thin, when answers keep exposing knowledge gaps, or when asked to bootstrap/expand what a knowledge base covers.
---

# Seeding a Magpie flow

Seeding is how a **flow** (one routable knowledge area) gets its documents. Magpie
explores the flow's configured source repositories, proposes a plan of documents to write,
and — once approved — drafts each one into the proposal → pull-request pipeline. Nothing
is published without review at both ends.

## The two steps

```
kb_outline { flow, notes? }   →  a persisted plan (proposal only, nothing drafted)
kb_seed    { plan }           →  approves it; one drafting job per approved item
```

### 1. `kb_outline` — propose

- Takes a `flow` id (from `kb_flows`) and an optional `notes` steer for this run.
  **No topic is needed** — the point is that Magpie reads the sources and decides what is
  worth documenting. Use `notes` to bias emphasis ("focus on the onboarding paths"), not to
  dictate a table of contents.
- It is a queued job and takes real time (minutes, not seconds). Do not fire it repeatedly.
- Returns the **persisted plan**: `{planId, charter?, charterProposed, persona?,
  personaProposed, items, rationale?}`. Each item is `{title?, targetPath?, coverage[],
  questions?}`.
- **`charterProposed` / `personaProposed` matter.** They mean the flow config had no
  charter/persona so the model invented one for this run. Show the proposed value to the
  user and tell them to copy it into `KNOWLEDGE_FLOWS` to make it permanent — otherwise the
  next run invents a different one and the flow's voice drifts.

### 2. Review before `kb_seed`

`kb_outline` only proposes. **Show the plan and get a human decision.** Walk the items:
do the `targetPath`s fit the existing tree, does `coverage` overlap documents that already
exist, is anything obviously missing? The console can edit a plan; you cannot edit it
through MCP — so if items need changing, send the user there rather than approving a plan
you know is wrong.

### 3. `kb_seed` — approve

- Takes `{plan}` — the `planId`. Approving drafts **one document per approved item**
  straight into the proposal → pull-request pipeline, carrying the plan's run-scoped
  charter/persona.
- Returns `{planId, jobIds}` — one enqueued drafting job per item. These are queued jobs
  too: the documents appear as proposals over the following minutes, not instantly.
- Approving is the point of no return for drafting effort. Don't approve a plan on your own
  initiative — it is a human's call, and both tools need the `manage:jobs` scope.

## When to reach for this

- A flow returns thin or gap-flagged answers repeatedly (`gaps` on `kb_ask`, or the gap
  candidates the console surfaces).
- A new flow has just been configured and has no documents.
- Sources changed substantially and coverage should be re-proposed.

Seeding is not the fix for a *single* missing answer — that is a knowledge gap; report it
with `kb_feedback` (see the `asking-magpie` skill) and let it cluster.

## Failure modes

- **Timeout on `kb_outline`** — the outline job is queued; without a watcher processing
  jobs it never completes. Report the timeout; don't retry blindly.
- **403** — outline and seed both require `manage:jobs`. That is a deliberate gate.
- **Drafts never appear after `kb_seed`** — the drafting jobs are queued the same way;
  check the console's job view rather than re-approving the plan.
