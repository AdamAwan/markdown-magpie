# Local-git publish capability + watcher-coverage banner

**Date:** 2026-07-03
**Status:** Approved (Adam)

## Problem

Two related gaps around publishing proposals to **local-git (`file://`) destinations**:

1. **Publishing a branch needs no GitHub, but is gated on it.** `publish_proposal`
   is defined with capability `github`
   ([`packages/jobs/src/catalog.ts`](../../../packages/jobs/src/catalog.ts)), whose
   readiness gate requires `GITHUB_TOKEN` + `MAGPIE_GIT_AUTHOR_*` + git. A
   `file://` publish only ever does a local `git push` (the PR step already
   degrades gracefully when it fails), so the token is never exercised — yet a
   local-git-only deployment still has to set a `GITHUB_TOKEN` just to get the
   `publish_proposal` job claimed. PR #136 added the *merge* half of local-git
   (inline in the API) but left the *publish* half coupled to `github`.

2. **No visibility when the running watcher fleet can't do some jobs.** If no
   watcher advertises a needed capability, jobs of that type silently sit queued
   forever. There is no proactive signal in the console.

## Goals

- A `file://` destination can be published by a watcher that has **git + author
  identity but no GitHub token**.
- The console shows a banner listing any job **types** that no currently-active
  watcher can execute.
- No behaviour change for GitHub destinations; merge stays exactly as-is (out of
  scope — see Non-goals).

## Non-goals

- Changing the local-git **merge** path (`mergeLocalProposal`, inline in the
  API). Unchanged. The "hosted Mark Merged redundancy tidy-up" remains a separate
  future task.
- Any change to `crosslink_pull_requests` / `comment_pull_request` — these call
  the GitHub API and stay `github`-only.

## Part A — `local-git` publish capability

### A1. New capability + gate

Add `local-git` to `JobCapability`
([`packages/jobs/src/types.ts`](../../../packages/jobs/src/types.ts)) and a
readiness gate in
[`apps/watcher/src/capabilities.ts`](../../../apps/watcher/src/capabilities.ts):

```
local-git → requiredEnv: [MAGPIE_GIT_AUTHOR_NAME, MAGPIE_GIT_AUTHOR_EMAIL]
            ready: those set AND git binary available   (NO token)
```

Gates compose naturally: a watcher with `GITHUB_TOKEN` + author + git advertises
**both** `github` and `local-git`, so it publishes to remote and local
destinations alike. A token-less watcher advertises only `local-git`.

### A2. `publish_proposal` becomes destination-routed

`publish_proposal` stops being statically `github` and fans out over
`{github, local-git}` — two concrete queues `publish_proposal__github` /
`publish_proposal__local_git` — the same mechanism AI jobs use to fan out over
providers.

`define()` in the catalog gains a third capability-spec mode alongside the
existing static `JobCapability` and `"provider"`:

```ts
type CapabilitySpec =
  | JobCapability                                        // static, single queue
  | "provider"                                           // fan out over AI_PROVIDERS via input.provider
  | { field: string; capabilities: readonly JobCapability[] }; // fan out via input[field]
```

Every `JobDefinition` exposes a derived `readonly capabilities: readonly
JobCapability[]` (static → `[cap]`; provider → `AI_PROVIDERS`; fan-out →
`spec.capabilities`). `concreteWorkQueues()` collapses to "map each type's
`definition.capabilities` to a concrete queue", removing the AI special-case.
A queue's name is bare `type` when a definition has one capability, and
`${type}__${cap}` (with `-`→`_`) when it has several — so static jobs are
unchanged.

`requiredCapability(input)` for the fan-out mode reads `input[field]`, validates
membership in `spec.capabilities`, and throws a `TypeError` otherwise (mirrors
the existing provider validation — fail fast, no silent default).

`publishProposalInputSchema` gains `destination: z.enum(["github",
"local-git"])`. Publish input is now `{ proposalId, destination }`.

### A3. Enqueue-time routing (single decision point)

There are two enqueue sites — `requestProposalPublication`
([`apps/api/.../proposals/service.ts`](../../../apps/api/src/features/proposals/service.ts))
and `enqueueProposalPublish` in
[`apps/api/src/scheduling/fold.ts`](../../../apps/api/src/scheduling/fold.ts).
Both are routed through **one shared helper** in the proposals service:

```ts
export async function enqueuePublishProposal(ctx, proposal): Promise<JobView> {
  const destination = isLocalGitDestination(ctx, proposal) ? "local-git" : "github";
  return ctx.jobs.create("publish_proposal", { proposalId: proposal.id, destination });
}
```

`isLocalGitDestination` already exists and is config-only (cheap, no git/network).
With no destinations configured (legacy repo-based setups) it returns `false`, so
routing defaults to `github` exactly as today. `fold.ts` imports and calls the
helper instead of `ctx.jobs.create("publish_proposal", …)` directly.

### A4. Watcher runner

No capability-parameterized runner is needed. Runner selection is
`runners.find(r => r.supports(job.type))` and claim eligibility is driven
independently by `deriveCapabilities(env)`. So:

- Register `PublicationRunner` when **`github` OR `local-git`** is ready (today:
  only `github`). A local-git-only watcher advertises only `[local-git,
  maintenance]`, hence subscribes only to `publish_proposal__local_git` (+
  maintenance) queues and never claims crosslink/comment work — the runner's
  extra `supports()` entries are harmless.
- `RefreshFlowSnapshotRunner` stays `github`-only.
- In `PublicationRunner.publishProposal`, **skip the `raisePullRequest` step when
  `input.destination === "local-git"`** — there is no GitHub PR to open for a
  `file://` remote; the branch push is the whole job. This avoids a spurious
  attempt + warning log. GitHub destinations are unchanged.

## Part B — watcher-coverage banner

### B1. Shared capability→job-type map (single source of truth)

The web currently hardcodes `CAPABILITY_JOB_TYPES` in
[`apps/web/src/components/JobsPanel.tsx`](../../../apps/web/src/components/JobsPanel.tsx),
and it has **already drifted** (its provider list has 7 of the catalog's 14 AI
types). Add catalog-derived helpers to `@magpie/jobs`:

```ts
export function jobTypesForCapability(capability: JobCapability): JobType[];
// job types no capability in `available` can cover (a type is covered if ANY of
// its capabilities is available — so publish_proposal is covered by github OR local-git):
export function jobTypesWithoutCapabilities(available: Iterable<JobCapability>): JobType[];
```

`JobsPanel` drops its local map and uses `jobTypesForCapability`, killing the
drift. (Both helpers are consumed, satisfying knip STRICT.)

### B2. The notice

Thread `workers: WatcherView[]` (already in `ConsoleProvider`) into
`buildAttentionNotices()`
([`apps/web/src/lib/console.ts`](../../../apps/web/src/lib/console.ts)):

- **≥1 active watcher, but coverage gaps** → `danger` notice: *"No watcher can run
  these jobs: Publish Proposal, …"* + guidance to start a watcher with the
  matching capability. Computed as
  `jobTypesWithoutCapabilities(union of workers' capabilities)`, formatted via the
  existing `formatJobType`.
- **0 active watchers** → a single concise `warning` notice *"No watchers are
  connected"* instead of dumping all ~22 types (which would be noise; the existing
  "queued jobs waiting" notice already nudges toward starting a watcher).

Notice ordering stays stable (there is an existing ordering test).

## Data flow

```
API enqueue: proposal → isLocalGitDestination? → publish_proposal{destination}
  → queue publish_proposal__github | publish_proposal__local_git
watcher: deriveCapabilities(env) advertises github and/or local-git
  → claims from matching queue → PublicationRunner
  → push branch; if destination==="github" also raise PR; else skip
web: GET /workers → union capabilities → jobTypesWithoutCapabilities → banner
```

## Testing

- **catalog.test.ts**: two publish queues exist; `queueNameForJob` routes by
  `input.destination`; `requiredCapability` validates/throws; static + provider
  jobs unchanged; `jobTypesForCapability` / `jobTypesWithoutCapabilities`.
- **capabilities.test.ts**: `local-git` ready with author+git and no token;
  not ready without git or author; github watcher advertises both.
- **publication.test.ts**: local-git publish pushes branch and does NOT call
  `raisePullRequest`; github publish still raises a PR.
- **proposals service / fold tests**: enqueued input carries the right
  `destination`; local-git destination → `local-git`, others → `github`.
- **console.test.tsx**: gap notice lists uncovered types; full coverage → no
  notice; 0 watchers → concise notice; ordering preserved.

## Docs

- `docs/ai-jobs.md` capability table: add `local-git`; note `publish_proposal`
  fans out github/local-git.
- `magpie-orientation` skill capability list: mention `local-git`.

## Rollout / compat

Additive. Existing `github` watchers keep publishing to both destination kinds
(they advertise `local-git` too). In-flight `publish_proposal` jobs enqueued
before deploy lack `destination`; the input schema change means the watcher would
reject them — acceptable given the queue drains fast, but the runner will treat a
missing `destination` as `github` (schema `.default("github")`) so old jobs still
complete. New enqueues always set it explicitly.
