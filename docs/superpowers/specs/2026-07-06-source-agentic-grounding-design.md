# Source-agentic grounding — design

**Date:** 2026-07-06
**Status:** approved for planning

## Problem

Every job that authors or checks content against a flow's *sources* is grounded by
`collectSourceContext` (`apps/api/src/platform/source-context.ts`): a blind walk of the
source checkout that reads at most 24 files (8KB each, 80KB total), priority-sorted
READMEs-first. For a small docs source that is adequate. For a real source — an entire
product codebase — the relevant files are statistically never in the sample, so the model
honestly reports "the source materials do not contain specifications for X" and authors a
placeholder full of open questions instead of a grounded document.

The two knowledge bases have different access needs, and the current design conflates them:

- **Destination KB** (ours): curated Markdown, indexed and embedded. Scoped slices in job
  payloads plus API-backed retrieval callbacks are the right access model. **Unchanged by
  this design.**
- **Source** (potentially third-party): arbitrary shape and size, no index, and it should
  not need one. What generative work needs is what a coding agent does: **a checkout it can
  traverse** — list directories, follow structure, open the files that matter.

Three consumers ride on the blind sampler today, and all three move:

1. **Seeding** — `draft_seed_document` / `outline_flow_seed` (`apps/api/src/features/seed/`)
2. **Gap drafting** — `draft_markdown_proposal` via `draftFromGaps`
   (`apps/api/src/features/proposals/service.ts`)
3. **Patrols** — the verify/correct/improve maintenance jobs that consume the shared source
   corpus via `sourcesRef` → `api.getSourceCorpus`

## Decision summary

| Decision | Choice |
| --- | --- |
| Scope | All three consumers, phased in three increments |
| Gating | Automatic by source kind — `git`/`local` sources get agentic access; `internet`/`agent` keep placeholder notes. No flag, no fallback mode; the sampler is deleted. |
| Execution | Two tiers by watcher capability: CLI agents (`claude`/`codex`) traverse natively; HTTP providers (`openai-compatible`/`azure-openai`) get a Vercel AI SDK tool loop |
| Payloads | Reference-based: job inputs carry source *descriptors*, never file content |
| Rejected | API-mediated file access over HTTP callbacks (chatty; incompatible with CLI-agent traversal). Indexing sources for vector retrieval (wrong tool for third-party code repos; churn cost). |

## Contract: source descriptors

Source-grounded job inputs replace inline `sourceContext: SourceDataContext[]` (and the
patrol `sourcesRef` corpus reference) with descriptors projected from the flow's configured
sources (`ConfiguredKnowledgeRepository`):

```ts
type SourceDescriptor =
  | { id: string; name: string; kind: "git";   url: string;  subpath?: string }
  | { id: string; name: string; kind: "local"; path: string; subpath?: string }
  | { id: string; name: string; kind: "internet"; url?: string }
  | { id: string; name: string; kind: "agent" };
```

- Defined in `@magpie/core`; carried on the inputs of `draft_seed_document`,
  `draft_markdown_proposal`, and the patrol jobs (schemas in `@magpie/jobs`).
- The API resolves `flow → sourceIds → configured sources → descriptors` at enqueue time.
  This is the surviving remnant of `selectSources`; the file walk, priority sort, byte
  caps, per-run memo (`SourceContextCache`), and the patrol corpus snapshot
  (`sourcesRef`, `getSourceCorpus`, its API endpoint and store) are all deleted in
  increment 3.
- `outline_flow_seed` is grounded in the *destination* (existing docs) and is unchanged.

## Watcher: source workspaces

New module `apps/watcher/src/source-workspace.ts`:

```ts
prepareSourceWorkspaces(descriptors, checkoutRoot): Promise<{
  workspaces: SourceWorkspace[];   // { sourceId, name, rootDir }
  notes: string[];                 // internet/agent placeholder lines + partial-failure notes
}>
```

- `git` → `ensureGitCheckout` (from `@magpie/git`) into `MAGPIE_CHECKOUT_ROOT` — the same
  plumbing and volume `runners/publication.ts` uses for destination checkouts. Root is the
  checkout joined with `subpath`.
- `local` → verify the directory exists; root is the path joined with `subpath`. Local
  sources must live on a path visible to both API and watcher (already effectively required
  today).
- `internet` / `agent` → no workspace; a one-line note is rendered into the prompt
  (current placeholder behaviour, unchanged).

Doctrine note: the watcher still has no database access and no inline orchestration. The
shared checkout volume — already hosting destination checkouts for publication — now also
hosts source checkouts. That is an extension of an existing mechanism, not a new channel.

## Tier 1 — CLI providers (`claude`, `codex`)

`CliRunner` (`apps/watcher/src/runners/cli.ts`) gains a source-grounded mode, active when
the job's resolved workspaces are non-empty:

- **cwd** = primary workspace root (the first fs-backed descriptor in the flow's source
  order). Additional workspaces: `--add-dir <root>` for claude;
  listed as absolute paths in the prompt for codex (its read-only sandbox permits reads
  outside cwd).
- **Read-only enforcement**, assembled by the runner (not user-configurable):
  - claude: `-p --allowedTools "Read,Grep,Glob"` (no Write/Edit/Bash)
  - codex: `exec --sandbox read-only`
- **Timeout:** source-grounded jobs default to 10 minutes via `MAGPIE_AGENTIC_TIMEOUT_MS`;
  all other jobs keep the existing 120s default.
- **Output contract unchanged:** prompt demands JSON-only as the final message;
  `parseJobOutput` is untouched.

## Tier 2 — HTTP providers (`openai-compatible`, `azure-openai`)

New module `apps/watcher/src/runners/source-agent.ts` runs a bounded tool loop with the
**Vercel AI SDK**. New watcher dependencies: `ai`, `@ai-sdk/openai-compatible`,
`@ai-sdk/azure` — the language-model binding is built from the same env config the existing
`ChatProvider` uses (base URL, key, model/deployment).

Three read-only tools, all path-confined to the workspace roots:

| Tool | Behaviour | Caps |
| --- | --- | --- |
| `list_dir({path})` | entries with name/type/size; ignore-dirs filtered (`.git`, `node_modules`, `dist`, …) | — |
| `read_file({path, offset?})` | text files only (existing extension filter) | 32KB per call |
| `grep({pattern, glob?})` | TypeScript regex walk over the workspace (no ripgrep dependency) | 50 matches, one snippet each |

**Path confinement** (the security-relevant core): every tool argument is realpath-resolved
and must remain under a workspace root; traversal (`..`), absolute paths outside roots, and
symlinks escaping a root are rejected — as tool-error *results* fed back to the model, not
job failures.

**Loop bounds:** max 24 steps, then one forced final answer (the `forceAnswer` pattern from
the answer loop in `runners/generative.ts`); 400KB cumulative tool-result budget with
oldest-result truncation noted to the model.

**Dispatch:** the generative runner branches — workspaces non-empty + HTTP capability →
tool loop; workspaces empty (internet/agent-only flows) → the existing one-shot
`buildPrompt` path. CLI capability is handled entirely by Tier 1.

## Prompts

The source-grounded prompts in `@magpie/prompts` (`DRAFT_SEED_DOCUMENT`,
`DRAFT_MARKDOWN_PROPOSAL`, patrol prompts) replace the `sourceContext` input contract with
an exploration preamble: *you have direct access to the source repository; explore it —
locate the relevant modules, follow imports — and ground every claim in files you actually
read; cite file paths.* The existing fabrication guards (never invent facts; where sources
genuinely do not cover a point, say so plainly) survive verbatim. Tier 1 and Tier 2 share
the same prompt text; only the tool vocabulary sentence differs.

## Error handling

- **No fs-backed source resolves** (clone failure, missing path) while the flow has
  `git`/`local` sources configured → the job fails loudly and the queue retry policy
  applies. No silent degradation to an ungrounded draft — the current silent-placeholder
  failure mode is the bug this design exists to kill.
- **Partial resolution** → proceed with the workspaces that resolved; an explicit note in
  the prompt names what is missing.
- **Tool misuse** (escape attempt, binary file, oversized read) → error result to the
  model; the loop continues.
- **Unparseable final JSON** → exactly today's behaviour (`parseJobOutput`).

## Security posture

Third-party source content is untrusted input to an agent. Containment: read-only
enforcement at the CLI sandbox / tool-implementation level; no write or network tools in
Tier 2; path confinement with realpath checks; and the existing human review gate — every
output lands as a draft proposal a human approves before merge. Prompt injection from
source content can at worst distort a draft, which review catches; it cannot touch the
filesystem or the destination repo.

## Testing

- **Unit:** path confinement (traversal, symlink, absolute-path escapes); tool
  implementations over a fixture directory; descriptor projection from configured sources;
  workspace preparation with a fake checkout fn (existing `ensureGitCheckout` test seam).
- **CliRunner:** flag/cwd assembly via the existing fake-spawn seam — asserts read-only
  flags are always present in source-grounded mode.
- **Tool loop:** AI SDK mock language model with scripted tool calls — happy path, budget
  exhaustion → forced answer, tool-error recovery.
- **Integration (Postgres-gated):** seed a flow from a fixture git repo end-to-end.
- **Queue e2e:** deterministic provider fixture gains a source-grounded case.

## Increments

1. **Seeding** — descriptor contract, `source-workspace.ts`, both tiers, prompt updates,
   wired into `draft_seed_document`.
2. **Gap drafting** — `draft_markdown_proposal` / `draftFromGaps` moves over.
3. **Patrols + demolition** — patrol jobs move over; delete `collectSourceContext`, the
   sampler walk, `SourceContextCache`, `sourcesRef`, `getSourceCorpus`, and the corpus
   store/endpoint. Knip enforces the cleanup (de-export, don't relax the config).

Each increment is its own PR with build/test/typecheck/lint green, and updates the docs it
touches (`docs/architecture.md`, `docs/ai-jobs.md`, the magpie-orientation skill's source
material notes).

## Open questions deferred to planning

- Exact claude/codex flag spellings verified against the CLI versions pinned in the
  deployment (flag names drift between CLI releases; increment 1 pins and asserts them).
- Whether `outline_flow_seed` should *also* see source structure (a directory tree) when
  proposing a seed plan — deferred; it plans against existing docs today and that remains
  true.
