# Source-Agentic Seeding (Increment 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the blind 24-file source sample in seeding (`draft_seed_document`) with direct agentic access to source checkouts — CLI providers traverse natively, HTTP providers get a bounded Vercel AI SDK tool loop.

**Architecture:** Job payloads carry `SourceDescriptor[]` (references) instead of inline file content. The watcher resolves descriptors to workspaces on the shared checkout volume (`ensureGitCheckout`, same plumbing as publication). `CliRunner` spawns the agent CLI with `cwd` = workspace + read-only flags; `ChatRunner` runs a `generateText` tool loop (`list_dir`/`read_file`/`grep`, path-confined). Spec: `docs/superpowers/specs/2026-07-06-source-agentic-grounding-design.md`.

**Tech Stack:** TypeScript ESM/NodeNext, zod, node:test, Vercel AI SDK (`ai@^5`, `@ai-sdk/openai-compatible`, `@ai-sdk/azure`).

## Global Constraints

- ESM/NodeNext: relative imports need explicit `.js` extensions, even from `.ts`.
- Never cast through `unknown`/`any` to silence types; no hacky workarounds.
- Tests: `node:test`, colocated `*.test.ts`. Run via `npm test -w <workspace>` (never root-cwd `node --test` — `@magpie/*` resolves to stale dist otherwise).
- Cross-package type changes need `npm run build` before dependent workspace tests.
- knip runs STRICT in CI (`npm run deadcode`): de-export anything unused, never relax the config.
- Commit and push after every task. UK English in docs and prompts.
- Only `draft_seed_document` migrates in this increment. `outline_flow_seed`, `draft_markdown_proposal`, and patrols are untouched (increments 2–3).
- In-flight `draft_seed_document` jobs enqueued with the old shape will fail schema validation after deploy — acceptable (single-operator; re-seed).

---

### Task 1: SourceDescriptor contract, end-to-end on the enqueue side

**Files:**
- Modify: `packages/core/src/index.ts` (~line 779–797: `SeedItem` / `DraftSeedDocumentJobInput`)
- Modify: `packages/jobs/src/schemas.ts` (~line 184–193: `draftSeedDocumentInputSchema`)
- Create: `apps/api/src/platform/source-descriptors.ts`
- Test: `apps/api/src/platform/source-descriptors.test.ts`
- Modify: `apps/api/src/features/seed/service.ts`
- Modify existing tests: `apps/api/src/features/seed/service.test.ts`, `apps/api/src/features/seed/routes.test.ts` (they assert `sourceContext` on the enqueued input — change assertions to `sources`)

**Interfaces:**
- Produces (later tasks consume all of these):
  - `@magpie/core`: `SourceDescriptor` (discriminated union on `kind`)
  - `@magpie/core`: `DraftSeedDocumentJobInput.sources: SourceDescriptor[]` (replaces `sourceContext`)
  - `@magpie/jobs`: `sourceDescriptorSchema`, updated `draftSeedDocumentInputSchema`
  - `apps/api`: `projectSourceDescriptors(deps: RepositoryDeps, sourceIds: string[] | undefined): SourceDescriptor[]`

- [ ] **Step 1: Add the type to `@magpie/core`**

In `packages/core/src/index.ts`, above `DraftSeedDocumentJobInput`:

```ts
// A reference to one of a flow's configured sources, carried on source-grounded
// job inputs INSTEAD of inline file content. git/local descriptors resolve to a
// traversable workspace on the watcher (see the source-agentic grounding spec);
// internet/agent render as prompt notes only.
export type SourceDescriptor =
  | { id: string; name: string; kind: "git"; url: string; subpath?: string }
  | { id: string; name: string; kind: "local"; path: string; subpath?: string }
  | { id: string; name: string; kind: "internet"; url?: string }
  | { id: string; name: string; kind: "agent" };
```

Change `DraftSeedDocumentJobInput` (keep the surrounding comment, update its wording from "grounded in `sourceContext`" to "grounded in the source repositories named by `sources`"):

```ts
export interface DraftSeedDocumentJobInput {
  flowId: string;
  title?: string;
  targetPath?: string;
  coverage: string[];
  questions?: string[];
  sources: SourceDescriptor[];
  destinationId?: string;
}
```

- [ ] **Step 2: Write the failing schema test**

In `packages/jobs/src/catalog.test.ts` (follow the file's existing test style), add:

```ts
it("draft_seed_document input carries source descriptors, not inline content", () => {
  const input = {
    provider: "openai-compatible",
    flowId: "flow-1",
    coverage: ["how statements are ingested"],
    sources: [
      { id: "src-1", name: "Product repo", kind: "git", url: "https://example.com/repo.git", subpath: "Docs" },
      { id: "src-2", name: "Local notes", kind: "local", path: "/srv/notes" },
      { id: "src-3", name: "Vendor site", kind: "internet", url: "https://vendor.example" },
      { id: "src-4", name: "Agent knowledge", kind: "agent" }
    ]
  };
  assert.equal(draftSeedDocumentInputSchema.safeParse(input).success, true);
  const legacy = { provider: "openai-compatible", flowId: "flow-1", coverage: ["x"], sourceContext: [] };
  assert.equal(draftSeedDocumentInputSchema.safeParse(legacy).success, false);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm run build && npm test -w packages/jobs`
Expected: FAIL (schema still requires `sourceContext`; `sources` unknown).

- [ ] **Step 4: Update the jobs schema**

In `packages/jobs/src/schemas.ts`, add below `sourceDataContextSchema` (which stays — `draft_markdown_proposal` still uses it until increment 2):

```ts
// Mirrors @magpie/core SourceDescriptor. References only — no file content.
const sourceDescriptorSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), name: z.string(), kind: z.literal("git"), url: z.string(), subpath: z.string().optional() }),
  z.object({ id: z.string(), name: z.string(), kind: z.literal("local"), path: z.string(), subpath: z.string().optional() }),
  z.object({ id: z.string(), name: z.string(), kind: z.literal("internet"), url: z.string().optional() }),
  z.object({ id: z.string(), name: z.string(), kind: z.literal("agent") })
]);
```

In `draftSeedDocumentInputSchema`, replace `sourceContext: z.array(sourceDataContextSchema),` with `sources: z.array(sourceDescriptorSchema),`. The `satisfies z.ZodType<ProviderInput<CoreDraftSeedDocumentJobInput>>` clause will enforce agreement with the core type.

- [ ] **Step 5: Run to verify it passes**

Run: `npm run build && npm test -w packages/jobs && npm test -w packages/core`
Expected: PASS.

- [ ] **Step 6: Write the failing projection test**

Create `apps/api/src/platform/source-descriptors.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectSourceDescriptors } from "./source-descriptors.js";
import type { RepositoryDeps } from "./repositories.js";

function depsWith(sources: RepositoryDeps["knowledgeConfig"]["sources"]): RepositoryDeps {
  return { knowledgeConfig: { sources }, checkoutRoot: "/tmp/checkouts" } as RepositoryDeps;
}

describe("projectSourceDescriptors", () => {
  it("projects each configured kind to its descriptor shape", () => {
    const deps = depsWith([
      { id: "g", name: "Repo", kind: "git", url: "https://example.com/r.git", subpath: "Docs" },
      { id: "l", name: "Notes", kind: "local", path: "/srv/notes" },
      { id: "i", name: "Site", kind: "internet", url: "https://x.example" },
      { id: "a", name: "Agent", kind: "agent" }
    ]);
    assert.deepEqual(projectSourceDescriptors(deps, ["g", "l", "i", "a"]), [
      { id: "g", name: "Repo", kind: "git", url: "https://example.com/r.git", subpath: "Docs" },
      { id: "l", name: "Notes", kind: "local", path: "/srv/notes" },
      { id: "i", name: "Site", kind: "internet", url: "https://x.example" },
      { id: "a", name: "Agent", kind: "agent" }
    ]);
  });

  it("defaults to the first three configured sources when no ids are requested", () => {
    const deps = depsWith(
      ["a", "b", "c", "d"].map((id) => ({ id, name: id, kind: "local" as const, path: `/srv/${id}` }))
    );
    assert.deepEqual(projectSourceDescriptors(deps, undefined).map((d) => d.id), ["a", "b", "c"]);
  });

  it("skips a git source with no resolvable url and a local source with no path", () => {
    const deps = depsWith([
      { id: "bad-git", name: "x", kind: "git" },
      { id: "bad-local", name: "y", kind: "local" }
    ]);
    assert.deepEqual(projectSourceDescriptors(deps, ["bad-git", "bad-local"]), []);
  });
});
```

Note: build `depsWith` to satisfy the real `RepositoryDeps` type — read `apps/api/src/platform/repositories.ts` for its full shape and fill required fields with minimal fakes rather than casting. If a plain object literal cannot satisfy it, mirror how `apps/api/src/platform/source-context.ts`'s existing tests (or `apps/api/src/features/seed/service.test.ts`) construct deps and reuse that helper.

- [ ] **Step 7: Run to verify it fails**

Run: `npm test -w apps/api -- --test-name-pattern "projectSourceDescriptors"`
Expected: FAIL (module does not exist). If `-- --test-name-pattern` is not wired through the workspace test script, run the workspace's full test command; the new file fails to import either way.

- [ ] **Step 8: Implement the projection**

Create `apps/api/src/platform/source-descriptors.ts`:

```ts
import type { SourceDescriptor } from "@magpie/core";
import type { ConfiguredKnowledgeRepository } from "../stores/knowledge-repositories.js";
import type { RepositoryDeps } from "./repositories.js";

// Projects a flow's configured sources into the reference-only descriptors that
// source-grounded job inputs carry. This replaces the API-side file sampling that
// collectSourceContext performed for seeding: content is no longer collected here;
// the watcher resolves these references to traversable workspaces. Selection rules
// match the old sampler: explicit ids filter the configured set; no ids means the
// first three configured sources.
export function projectSourceDescriptors(
  deps: RepositoryDeps,
  sourceIds: string[] | undefined
): SourceDescriptor[] {
  const selected = selectSources(deps.knowledgeConfig.sources, sourceIds);
  const descriptors: SourceDescriptor[] = [];
  for (const source of selected) {
    const descriptor = toDescriptor(source);
    if (descriptor) {
      descriptors.push(descriptor);
    }
  }
  return descriptors;
}

function selectSources(
  sources: ConfiguredKnowledgeRepository[],
  sourceIds: string[] | undefined
): ConfiguredKnowledgeRepository[] {
  const requested = new Set((sourceIds ?? []).map((id) => id.trim()).filter(Boolean));
  if (requested.size === 0) {
    return sources.slice(0, 3);
  }
  return sources.filter((source) => requested.has(source.id));
}

// A source that cannot be referenced (a git source with no url, a local source
// with no path) is dropped rather than sent as an unresolvable reference.
function toDescriptor(source: ConfiguredKnowledgeRepository): SourceDescriptor | undefined {
  if (source.kind === "git") {
    return source.url
      ? { id: source.id, name: source.name, kind: "git", url: source.url, ...(source.subpath ? { subpath: source.subpath } : {}) }
      : undefined;
  }
  if (source.kind === "local") {
    return source.path
      ? { id: source.id, name: source.name, kind: "local", path: source.path, ...(source.subpath ? { subpath: source.subpath } : {}) }
      : undefined;
  }
  if (source.kind === "internet") {
    return { id: source.id, name: source.name, kind: "internet", ...(source.url ? { url: source.url } : {}) };
  }
  return { id: source.id, name: source.name, kind: "agent" };
}
```

Check `ConfiguredKnowledgeRepository`'s exact optional fields in `apps/api/src/stores/knowledge-repositories.ts` (`url`, `path`, `subpath` are all optional; `kind` is the four-value union) and adjust field access if names differ.

- [ ] **Step 9: Rewire the seed service**

In `apps/api/src/features/seed/service.ts`:
- Remove the imports of `collectSourceContextCached` and `SourceContextCache` (and the `cache` plumbing in `seedFlow`/`draftSeedItem`).
- Import `projectSourceDescriptors` from `../../platform/source-descriptors.js`.
- `draftSeedItem` loses its `cache` parameter and builds:

```ts
const input: DraftSeedDocumentJobInput & { provider: AiProviderName } = {
  flowId,
  title: item.title?.trim() || undefined,
  targetPath: item.targetPath?.trim() || undefined,
  coverage: [...new Set(item.coverage.map((point) => point.trim()).filter((point) => point.length > 0))],
  questions: item.questions?.length ? item.questions : undefined,
  sources: projectSourceDescriptors(deps, sourceIds),
  destinationId,
  provider: ctx.config.get().aiProvider
};
```

- `seedFlow` drops the `cache` const and passes nothing extra: `jobIds.push(await draftSeedItem(ctx, flowId, item));`.
- Update the file-top comments that mention memoised source context.

- [ ] **Step 10: Update the existing seed tests and run everything**

In `apps/api/src/features/seed/service.test.ts` and `routes.test.ts`, change assertions on the enqueued input from `sourceContext` to `sources` (descriptor shapes, no `content` field). Also grep the API workspace for other `draft_seed_document` input fixtures: `apps/api/src/features/jobs/service.test.ts` and `apps/api/src/features/proposals/service.test.ts` contain seed-input fixtures — update them to the new shape.

Run: `npm run build && npm test -w apps/api && npm run typecheck && npm run lint && npm run deadcode`
Expected: all PASS. If knip flags `collectSourceContextCached`/`SourceContextCache` as unused: they are still used by `draftFromGaps` in `apps/api/src/features/proposals/service.ts` — verify with grep before touching them; do NOT delete the sampler in this increment.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat(seed): carry source descriptors on draft_seed_document, not sampled content"
git push -u origin claude/source-agentic-seeding
```

---

### Task 2: Watcher source workspaces

**Files:**
- Create: `apps/watcher/src/source-workspace.ts`
- Test: `apps/watcher/src/source-workspace.test.ts`

**Interfaces:**
- Consumes: `SourceDescriptor` from `@magpie/core` (Task 1); `ensureGitCheckout` from `@magpie/git` (`(req: { id: string; url: string; checkoutRoot: string; branch?: string }) => Promise<{ localPath: string; remoteUrl: string }>`).
- Produces (Tasks 4–6 consume):
  - `interface SourceWorkspace { sourceId: string; name: string; rootDir: string }`
  - `interface PreparedSources { workspaces: SourceWorkspace[]; notes: string[] }`
  - `prepareSourceWorkspaces(descriptors, opts): Promise<PreparedSources>` — throws when fs-backed descriptors exist but none resolve
  - `hasFsSources(descriptors: SourceDescriptor[]): boolean`

- [ ] **Step 1: Write the failing tests**

Create `apps/watcher/src/source-workspace.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { SourceDescriptor } from "@magpie/core";
import { hasFsSources, prepareSourceWorkspaces } from "./source-workspace.js";

const git = (over: Partial<Extract<SourceDescriptor, { kind: "git" }>> = {}): SourceDescriptor => ({
  id: "g1", name: "Repo", kind: "git", url: "https://example.com/r.git", ...over
});

describe("prepareSourceWorkspaces", () => {
  it("checks out git sources and roots them at the subpath", async () => {
    const checkoutRoot = mkdtempSync(path.join(tmpdir(), "magpie-ws-"));
    const cloned = path.join(checkoutRoot, "g1");
    mkdirSync(path.join(cloned, "Docs"), { recursive: true });
    const checkout = async (req: { id: string; url: string; checkoutRoot: string }) => {
      assert.equal(req.id, "g1");
      assert.equal(req.url, "https://example.com/r.git");
      return { localPath: cloned, remoteUrl: req.url };
    };
    const prepared = await prepareSourceWorkspaces([git({ subpath: "Docs" })], { checkoutRoot, checkout });
    assert.deepEqual(prepared.workspaces, [{ sourceId: "g1", name: "Repo", rootDir: path.join(cloned, "Docs") }]);
    assert.deepEqual(prepared.notes, []);
  });

  it("uses local sources in place and notes internet/agent sources", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "magpie-local-"));
    writeFileSync(path.join(dir, "readme.md"), "hi");
    const prepared = await prepareSourceWorkspaces(
      [
        { id: "l1", name: "Notes", kind: "local", path: dir },
        { id: "i1", name: "Site", kind: "internet", url: "https://x.example" },
        { id: "a1", name: "Agent", kind: "agent" }
      ],
      { checkoutRoot: dir }
    );
    assert.deepEqual(prepared.workspaces, [{ sourceId: "l1", name: "Notes", rootDir: dir }]);
    assert.equal(prepared.notes.length, 2);
    assert.match(prepared.notes[0]!, /https:\/\/x\.example/);
  });

  it("degrades to a note when one fs source fails but another resolves", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "magpie-partial-"));
    const failing = async () => {
      throw new Error("clone failed");
    };
    const prepared = await prepareSourceWorkspaces(
      [git(), { id: "l1", name: "Notes", kind: "local", path: dir }],
      { checkoutRoot: dir, checkout: failing }
    );
    assert.equal(prepared.workspaces.length, 1);
    assert.equal(prepared.notes.length, 1);
    assert.match(prepared.notes[0]!, /Repo.*unavailable/i);
  });

  it("throws when fs sources are configured but none resolve", async () => {
    const failing = async () => {
      throw new Error("clone failed");
    };
    await assert.rejects(
      prepareSourceWorkspaces([git()], { checkoutRoot: tmpdir(), checkout: failing }),
      /no source workspace could be prepared/i
    );
  });

  it("hasFsSources is true only for git/local descriptors", () => {
    assert.equal(hasFsSources([{ id: "a", name: "a", kind: "agent" }]), false);
    assert.equal(hasFsSources([git()]), true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npm test -w apps/watcher`
Expected: FAIL — cannot find `./source-workspace.js`.

- [ ] **Step 3: Implement**

Create `apps/watcher/src/source-workspace.ts`:

```ts
import { existsSync } from "node:fs";
import path from "node:path";
import type { SourceDescriptor } from "@magpie/core";
import { ensureGitCheckout } from "@magpie/git";
import { logger } from "./logger.js";

// A resolved, traversable root for one fs-backed source. Both execution tiers
// consume this: the CLI tier as cwd/--add-dir, the tool-loop tier as the
// confinement roots for its read-only tools.
export interface SourceWorkspace {
  sourceId: string;
  name: string;
  rootDir: string;
}

export interface PreparedSources {
  workspaces: SourceWorkspace[];
  // Prompt lines for sources with no filesystem: internet/agent placeholders and
  // fs sources that failed to resolve (partial degradation, named explicitly).
  notes: string[];
}

export function hasFsSources(descriptors: SourceDescriptor[]): boolean {
  return descriptors.some((d) => d.kind === "git" || d.kind === "local");
}

// Resolves source descriptors to workspaces on the shared checkout volume — the
// same volume and ensureGitCheckout plumbing the publication runner uses for
// destinations, so API and watcher share one checkout per source id. Fails loudly
// when fs sources were configured but NONE resolved: a seed drafted with zero real
// source access is exactly the silent-placeholder failure this feature removes.
export async function prepareSourceWorkspaces(
  descriptors: SourceDescriptor[],
  options: { checkoutRoot: string; checkout?: typeof ensureGitCheckout }
): Promise<PreparedSources> {
  const checkout = options.checkout ?? ensureGitCheckout;
  const workspaces: SourceWorkspace[] = [];
  const notes: string[] = [];

  for (const descriptor of descriptors) {
    if (descriptor.kind === "internet") {
      notes.push(
        descriptor.url
          ? `Internet source "${descriptor.name}": ${descriptor.url} (reference only; not fetched).`
          : `Internet source "${descriptor.name}": use relevant internet research as supporting material.`
      );
      continue;
    }
    if (descriptor.kind === "agent") {
      notes.push(`Agent source "${descriptor.name}": use general knowledge as supporting material.`);
      continue;
    }
    try {
      const rootDir =
        descriptor.kind === "git"
          ? withSubpath((await checkout({ id: descriptor.id, url: descriptor.url, checkoutRoot: options.checkoutRoot })).localPath, descriptor.subpath)
          : withSubpath(descriptor.path, descriptor.subpath);
      if (!existsSync(rootDir)) {
        throw new Error(`resolved root does not exist: ${rootDir}`);
      }
      workspaces.push({ sourceId: descriptor.id, name: descriptor.name, rootDir });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unavailable";
      logger.warn({ sourceId: descriptor.id, err: message }, "source workspace unavailable");
      notes.push(`Source "${descriptor.name}" is unavailable (${message}).`);
    }
  }

  if (workspaces.length === 0 && hasFsSources(descriptors)) {
    throw new Error("no source workspace could be prepared: every filesystem-backed source failed to resolve");
  }
  return { workspaces, notes };
}

function withSubpath(root: string, subpath: string | undefined): string {
  return subpath ? path.join(root, subpath) : root;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -w apps/watcher`
Expected: PASS (all new tests; existing suite green).

- [ ] **Step 5: Commit**

```bash
git add apps/watcher/src/source-workspace.ts apps/watcher/src/source-workspace.test.ts
git commit -m "feat(watcher): resolve source descriptors to shared-volume workspaces"
git push
```

---

### Task 3: Prompt updates — exploration contract

**Files:**
- Modify: `packages/prompts/src/catalog.ts` (~line 141–170, `DRAFT_SEED_DOCUMENT`)
- Modify: `apps/watcher/src/job-prompts.ts` (add `buildSourceGroundedPrompt`)
- Test: `apps/watcher/src/job-prompts.test.ts` (extend), `packages/prompts/src/catalog.test.ts` (fix any instruction-text assertions)

**Interfaces:**
- Consumes: `SourceWorkspace` (Task 2), `JOB_INSTRUCTIONS`/`JobView` (existing).
- Produces (Tasks 4–6 consume): `buildSourceGroundedPrompt(job: JobView, workspaces: SourceWorkspace[], notes: string[], mode: "cli" | "tools"): string`.

- [ ] **Step 1: Rewrite the DRAFT_SEED_DOCUMENT instructions**

In `packages/prompts/src/catalog.ts`, replace the `instructions` template of `DRAFT_SEED_DOCUMENT` with (keep `id`, `title`, `usedBy`, `outputShape`; update `description` to say "grounded in the flow's source repositories, which the executing agent explores directly"):

```ts
  instructions: `You author a single new Markdown knowledge-base document, grounded in the source repositories you have been given access to.

Input:
- "coverage": the points this document must cover. Author the whole document around these.
- "questions" (optional): motivating questions/prompts for context.
- "title"/"targetPath" (optional): use them if given; otherwise choose a clear title and a sensible kebab-case path.

Grounding:
- You have DIRECT access to the source repositories listed in the prompt. Explore them: list directories to learn the structure, search for terms from "coverage", open the files that matter, and follow references between files. Do not stop at the first file — corroborate across the codebase and docs.
- Ground every factual claim in files you actually read, and cite their repository paths in the text (e.g. "(see Docs/Specifications/Statements/ingestion.md)").
- Never introduce assertions the sources do not support. Do not fabricate figures, dates, or APIs. If, after genuinely searching, the sources do not cover a point, write only what can be supported and note the gap plainly.

Rules:
- Your FINAL message must be JSON only, matching the shape below. No prose around it.
- Write clean, well-structured Markdown with headings; UK English. Include frontmatter with title and status: draft.
- "rationale" is a one-paragraph summary of what the document covers and which source files grounded it.

Return JSON:
{
  "title": "the document title",
  "targetPath": "kebab-case/path.md",
  "markdown": "the full document",
  "rationale": "string"
}`
```

Run `npm test -w packages/prompts` and fix any assertion in `catalog.test.ts` that pinned the old wording.

- [ ] **Step 2: Write the failing prompt-builder test**

In `apps/watcher/src/job-prompts.test.ts`, add (match the file's existing describe/it style and JobView fixture helpers):

```ts
describe("buildSourceGroundedPrompt", () => {
  const job = {
    id: "j1",
    type: "draft_seed_document",
    input: {
      provider: "openai-compatible",
      flowId: "f1",
      coverage: ["statement ingestion"],
      sources: [{ id: "s1", name: "Product repo", kind: "git", url: "https://example.com/r.git" }]
    }
  } as JobView;
  const workspaces = [{ sourceId: "s1", name: "Product repo", rootDir: "/checkouts/s1" }];

  it("lists workspaces, omits the sources field from the input JSON, and ends with the input", () => {
    const prompt = buildSourceGroundedPrompt(job, workspaces, ["Source \"X\" is unavailable (gone)."], "cli");
    assert.match(prompt, /Product repo/);
    assert.match(prompt, /\/checkouts\/s1/);
    assert.match(prompt, /unavailable \(gone\)/);
    assert.doesNotMatch(prompt, /"sources"/);
    assert.ok(prompt.indexOf("statement ingestion") > prompt.indexOf("Product repo"));
  });

  it("describes tool-loop paths for the tools mode", () => {
    const prompt = buildSourceGroundedPrompt(job, workspaces, [], "tools");
    assert.match(prompt, /list_dir/);
    assert.match(prompt, /s1\//);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm run build && npm test -w apps/watcher`
Expected: FAIL — `buildSourceGroundedPrompt` is not exported.

- [ ] **Step 4: Implement `buildSourceGroundedPrompt`**

In `apps/watcher/src/job-prompts.ts`, next to `buildPrompt` (import `SourceWorkspace` from `../source-workspace.js` — adjust the relative path to `./source-workspace.js` since job-prompts.ts sits in `src/`):

```ts
// Prompt for source-grounded jobs on the agentic paths. The instructions come
// from the same catalog entry both tiers share; what differs is how the agent
// addresses the source material — the CLI tier works inside the checkout with its
// native tools, the tool-loop tier addresses "<sourceId>/<relative path>" through
// list_dir/read_file/grep. The job input is rendered WITHOUT the `sources` field:
// the descriptors were resolved into the workspace listing above, so the raw
// references would be noise.
export function buildSourceGroundedPrompt(
  job: JobView,
  workspaces: SourceWorkspace[],
  notes: string[],
  mode: "cli" | "tools"
): string {
  const instructions = JOB_INSTRUCTIONS[job.type] ?? GENERIC_JOB.instructions;
  const workspaceLines = workspaces
    .map((ws) =>
      mode === "cli"
        ? `- ${ws.name}: ${ws.rootDir}${workspaces.indexOf(ws) === 0 ? " (your working directory)" : ""}`
        : `- ${ws.name}: address paths as "${ws.sourceId}/<relative path>" in list_dir/read_file/grep`
    )
    .join("\n");
  const access =
    mode === "cli"
      ? "Source repositories available (read-only; explore with your file tools):"
      : "Source repositories available through your tools (list_dir, read_file, grep):";
  const noteBlock = notes.length > 0 ? `\nSource notes:\n${notes.map((n) => `- ${n}`).join("\n")}\n` : "";
  const input = omitInputKeys(job.input, ["sources", "sourcesRef"]);
  return `${access}\n${workspaceLines}\n${noteBlock}\n${instructions}\n\nInput:\n${JSON.stringify(input, null, 2)}`;
}

// A shallow copy of a job input without the named keys.
function omitInputKeys(input: unknown, keys: string[]): unknown {
  if (typeof input !== "object" || input === null) {
    return input;
  }
  return Object.fromEntries(Object.entries(input).filter(([key]) => !keys.includes(key)));
}
```

Refactor the existing `omitSourcesRef` to call `omitInputKeys(input, ["sourcesRef"])` so there is one omission helper (DRY), keeping `omitSourcesRef`'s callers unchanged — or inline-replace its single call site in `buildPrompt`.

- [ ] **Step 5: Run to verify pass, then commit**

Run: `npm run build && npm test -w apps/watcher && npm test -w packages/prompts`
Expected: PASS.

```bash
git add -A
git commit -m "feat(prompts): exploration-grounded seed prompt + source-grounded prompt builder"
git push
```

---

### Task 4: Tool-loop tools — path-confined list/read/grep

**Files:**
- Create: `apps/watcher/src/source-tools.ts`
- Test: `apps/watcher/src/source-tools.test.ts`

**Interfaces:**
- Consumes: `SourceWorkspace` (Task 2).
- Produces (Task 5 consumes):
  - `interface ToolBudget { remainingBytes: number }`
  - `resolveSourcePath(workspaces: SourceWorkspace[], requested: string): { workspace: SourceWorkspace; absolutePath: string }` — throws `SourceToolError` on escapes
  - `class SourceToolError extends Error`
  - `listDir(workspaces, requested: string): Promise<string>` (requested `""` lists `<sourceId>/` roots)
  - `readFile(workspaces, requested: string, budget: ToolBudget, offset?: number): Promise<string>`
  - `grepWorkspaces(workspaces, pattern: string, glob?: string): Promise<string>`

All tool results are strings (rendered for the model); all failures are thrown `SourceToolError`s the loop converts to error strings — a tool can never crash the job.

- [ ] **Step 1: Write the failing tests**

Create `apps/watcher/src/source-tools.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  grepWorkspaces,
  listDir,
  readFile,
  resolveSourcePath,
  SourceToolError,
  type ToolBudget
} from "./source-tools.js";

function fixture(): { root: string; workspaces: [{ sourceId: string; name: string; rootDir: string }] } {
  const root = mkdtempSync(path.join(tmpdir(), "magpie-tools-"));
  mkdirSync(path.join(root, "docs"));
  writeFileSync(path.join(root, "readme.md"), "# Statements\ningestion pipeline docs");
  writeFileSync(path.join(root, "docs", "spec.md"), "statement lines match invoices");
  writeFileSync(path.join(root, "app.bin"), Buffer.from([0, 1, 2]));
  return { root, workspaces: [{ sourceId: "s1", name: "Repo", rootDir: root }] };
}

describe("resolveSourcePath", () => {
  it("resolves <sourceId>/<relative> inside the workspace", () => {
    const { root, workspaces } = fixture();
    const resolved = resolveSourcePath(workspaces, "s1/docs/spec.md");
    assert.equal(resolved.absolutePath, path.join(root, "docs", "spec.md"));
  });

  it("rejects traversal, unknown workspaces, and absolute paths", () => {
    const { workspaces } = fixture();
    assert.throws(() => resolveSourcePath(workspaces, "s1/../../etc/passwd"), SourceToolError);
    assert.throws(() => resolveSourcePath(workspaces, "nope/readme.md"), SourceToolError);
    assert.throws(() => resolveSourcePath(workspaces, "/etc/passwd"), SourceToolError);
  });

  it("rejects symlinks that escape the workspace", function (t) {
    const { root, workspaces } = fixture();
    const outside = mkdtempSync(path.join(tmpdir(), "magpie-outside-"));
    writeFileSync(path.join(outside, "secret.txt"), "secret");
    try {
      symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    } catch {
      t.skip("symlinks unavailable on this platform");
      return;
    }
    assert.throws(() => resolveSourcePath(workspaces, "s1/link.txt"), SourceToolError);
  });
});

describe("tools", () => {
  it("lists roots for the empty path and entries for a directory", async () => {
    const { workspaces } = fixture();
    assert.match(await listDir(workspaces, ""), /s1\/ {2}\(Repo\)/);
    const listing = await listDir(workspaces, "s1");
    assert.match(listing, /docs\//);
    assert.match(listing, /readme\.md/);
  });

  it("reads text files against the budget and refuses binary files", async () => {
    const { workspaces } = fixture();
    const budget: ToolBudget = { remainingBytes: 1000 };
    const content = await readFile(workspaces, "s1/readme.md", budget);
    assert.match(content, /ingestion pipeline/);
    assert.ok(budget.remainingBytes < 1000);
    await assert.rejects(readFile(workspaces, "s1/app.bin", budget), SourceToolError);
  });

  it("greps across the workspace with match caps", async () => {
    const { workspaces } = fixture();
    const hits = await grepWorkspaces(workspaces, "statement");
    assert.match(hits, /docs\/spec\.md/);
    assert.match(hits, /match invoices/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w apps/watcher`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `apps/watcher/src/source-tools.ts`**

```ts
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readFile as fsReadFile } from "node:fs/promises";
import path from "node:path";
import type { SourceWorkspace } from "./source-workspace.js";

// Read-only filesystem tools for the HTTP-provider tool loop. Everything here is
// deliberately boring and bounded: string in, rendered string out, SourceToolError
// on misuse. The loop converts errors to tool results so the model can recover;
// nothing a model passes as an argument can reach outside a workspace root.

export class SourceToolError extends Error {}

export interface ToolBudget {
  remainingBytes: number;
}

const READ_CAP_BYTES = 32_000;
const GREP_MAX_MATCHES = 50;
const LIST_MAX_ENTRIES = 200;
const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "coverage", "vendor", ".turbo"]);
// Same text-file gate the old sampler used (source-context.ts) — binary content
// is never useful to the model and wrecks budgets.
const TEXT_FILE = /\.(?:md|mdx|txt|ts|tsx|js|jsx|mjs|cjs|json|yml|yaml|toml|py|go|rs|cs|java|kt|swift|php|rb|css|scss|html|sql|sh|ps1|xml|csv)$/i;

// Tool paths are "<sourceId>/<relative posix path>"; "" or "<sourceId>" address the
// root. realpath containment catches both `..` traversal and symlink escapes.
export function resolveSourcePath(
  workspaces: SourceWorkspace[],
  requested: string
): { workspace: SourceWorkspace; absolutePath: string } {
  const normalized = requested.replaceAll("\\", "/").replace(/^\/+/, "");
  if (path.isAbsolute(requested)) {
    throw new SourceToolError(`absolute paths are not allowed: ${requested}`);
  }
  const [head, ...rest] = normalized.split("/").filter(Boolean);
  const workspace = workspaces.find((ws) => ws.sourceId === head);
  if (!workspace) {
    throw new SourceToolError(
      `unknown source "${head ?? ""}". Paths start with a source id: ${workspaces.map((ws) => `${ws.sourceId}/`).join(", ")}`
    );
  }
  const rootReal = realpathSync(workspace.rootDir);
  const candidate = path.resolve(rootReal, ...rest);
  const candidateReal = safeRealpath(candidate);
  if (candidateReal !== rootReal && !candidateReal.startsWith(rootReal + path.sep)) {
    throw new SourceToolError(`path escapes the source workspace: ${requested}`);
  }
  return { workspace, absolutePath: candidateReal };
}

// realpath of the deepest existing ancestor, so a not-yet-checked path still gets
// containment-checked (the fs call on it will produce the not-found error).
function safeRealpath(candidate: string): string {
  try {
    return realpathSync(candidate);
  } catch {
    return path.join(safeRealpath(path.dirname(candidate)), path.basename(candidate));
  }
}

export async function listDir(workspaces: SourceWorkspace[], requested: string): Promise<string> {
  if (requested.trim() === "") {
    return workspaces.map((ws) => `${ws.sourceId}/  (${ws.name})`).join("\n");
  }
  const { absolutePath } = resolveSourcePath(workspaces, requested);
  const entries = readdirSync(absolutePath, { withFileTypes: true })
    .filter((entry) => !IGNORED_DIRS.has(entry.name))
    .slice(0, LIST_MAX_ENTRIES)
    .map((entry) => {
      if (entry.isDirectory()) {
        return `${entry.name}/`;
      }
      const size = statSync(path.join(absolutePath, entry.name)).size;
      return `${entry.name}  (${size} bytes)`;
    });
  return entries.length > 0 ? entries.join("\n") : "(empty directory)";
}

export async function readFile(
  workspaces: SourceWorkspace[],
  requested: string,
  budget: ToolBudget,
  offset = 0
): Promise<string> {
  const { absolutePath } = resolveSourcePath(workspaces, requested);
  if (!TEXT_FILE.test(absolutePath)) {
    throw new SourceToolError(`not a readable text file: ${requested}`);
  }
  if (budget.remainingBytes <= 0) {
    throw new SourceToolError("read budget exhausted; answer from what you have already read");
  }
  const content = await fsReadFile(absolutePath, "utf8");
  const slice = content.slice(offset, offset + Math.min(READ_CAP_BYTES, budget.remainingBytes));
  budget.remainingBytes -= slice.length;
  const suffix = offset + slice.length < content.length
    ? `\n\n[truncated at ${offset + slice.length} of ${content.length} chars; re-call with offset=${offset + slice.length} if needed]`
    : "";
  return slice + suffix;
}

export async function grepWorkspaces(
  workspaces: SourceWorkspace[],
  pattern: string,
  glob?: string
): Promise<string> {
  const regex = new RegExp(pattern, "i");
  const globRegex = glob ? globToRegex(glob) : undefined;
  const hits: string[] = [];
  for (const workspace of workspaces) {
    walk(workspace.rootDir, (absolute) => {
      if (hits.length >= GREP_MAX_MATCHES) {
        return;
      }
      const relative = `${workspace.sourceId}/${path.relative(workspace.rootDir, absolute).replaceAll("\\", "/")}`;
      if (!TEXT_FILE.test(absolute) || (globRegex && !globRegex.test(relative))) {
        return;
      }
      let content: string;
      try {
        content = readFileSync(absolute, "utf8");
      } catch {
        return;
      }
      for (const line of content.split("\n")) {
        if (regex.test(line)) {
          hits.push(`${relative}: ${line.trim().slice(0, 200)}`);
          if (hits.length >= GREP_MAX_MATCHES) {
            return;
          }
        }
      }
    });
  }
  return hits.length > 0 ? hits.join("\n") : "(no matches)";
}

function walk(dir: string, visit: (file: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, visit);
    } else if (entry.isFile()) {
      visit(full);
    }
  }
}

function globToRegex(glob: string): RegExp {
  // "*" matches within a path segment, "**" across segments. The "\0" placeholder
  // keeps the single-star replacement from mangling double stars.
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\0")
    .replace(/\*/g, "[^/]*")
    .replaceAll("\0", ".*");
  return new RegExp(`^${escaped}$`, "i");
}
```

**Fix before committing:** the `require("node:fs")` inside `grepWorkspaces` is a CJS-ism — import `readFileSync` at the top with the other fs imports and call it directly. (Written out here so the implementer sees the trap; the final file must use the ESM import.)

- [ ] **Step 4: Run to verify pass, then commit**

Run: `npm test -w apps/watcher && npm run lint`
Expected: PASS.

```bash
git add apps/watcher/src/source-tools.ts apps/watcher/src/source-tools.test.ts
git commit -m "feat(watcher): path-confined read-only source tools for the agent loop"
git push
```

---

### Task 5: Tier 2 — Vercel AI SDK loop + ChatRunner dispatch

**Files:**
- Modify: `apps/watcher/package.json` (new deps)
- Create: `apps/watcher/src/runners/source-agent.ts`
- Modify: `apps/watcher/src/runners/chat.ts`
- Modify: `apps/watcher/src/runners/index.ts` (build the `LanguageModel` per HTTP capability)
- Test: `apps/watcher/src/runners/source-agent.test.ts`, extend `apps/watcher/src/runners/chat.test.ts`

**Interfaces:**
- Consumes: `prepareSourceWorkspaces`/`hasFsSources` (Task 2), `buildSourceGroundedPrompt` (Task 3), tools (Task 4), `parseJobOutput` (existing), `draftSeedDocumentInputSchema` (Task 1).
- Produces:
  - `runSourceAgentJob(options: { job: JobView; model: LanguageModel; workspaces: SourceWorkspace[]; notes: string[]; signal: AbortSignal }): Promise<unknown>`
  - `sourceDescriptorsOf(job: JobView): SourceDescriptor[]` (in `source-workspace.ts`; returns `[]` for non-source-grounded job types)
  - `ChatRunner` constructor gains an optional 4th arg `agentModel?: LanguageModel`

- [ ] **Step 1: Install the SDK**

```bash
npm install ai @ai-sdk/openai-compatible @ai-sdk/azure -w apps/watcher
```

Then verify against the installed types (open `node_modules/ai/dist/index.d.ts` or use editor hover): `generateText`, `tool`, `stepCountIs`, `LanguageModel`, and that `tool({...})` takes `inputSchema` (AI SDK v5) — if the installed major uses `parameters` (v4), prefer upgrading to v5; only adapt the field name if v5 is unavailable. Also verify `createOpenAICompatible({ name, baseURL, apiKey })` and `createAzure(...)` option names (`baseURL` vs `resourceName`, `apiVersion`) in the installed `@ai-sdk/*` packages before writing Step 5's code, and adjust to match reality.

- [ ] **Step 2: Add `sourceDescriptorsOf` to `source-workspace.ts`**

```ts
import type { JobView } from "@magpie/jobs";
import { draftSeedDocumentInputSchema } from "@magpie/jobs";

// The source descriptors of a source-grounded job, [] for every other job type.
// Increment 1: seeding only; increments 2-3 add draft_markdown_proposal and the
// patrol jobs here.
export function sourceDescriptorsOf(job: JobView): SourceDescriptor[] {
  if (job.type !== "draft_seed_document") {
    return [];
  }
  const parsed = draftSeedDocumentInputSchema.safeParse(job.input);
  return parsed.success ? parsed.data.sources : [];
}
```

Add a unit test in `source-workspace.test.ts`: a `draft_seed_document` job input yields its descriptors; an `answer_question` job yields `[]`; a malformed seed input yields `[]`.

- [ ] **Step 3: Write the failing loop test**

Create `apps/watcher/src/runners/source-agent.test.ts`. Use the AI SDK's mock model (`import { MockLanguageModelV3 } from "ai/test"` — check the installed export name; v5 ships `MockLanguageModelV2` or `V3` under `ai/test`) to script: (turn 1) a `read_file` tool call on `s1/readme.md`, (turn 2) a final text answer that is valid `draft_seed_document` output JSON.

```ts
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { JobView } from "@magpie/jobs";
import { runSourceAgentJob } from "./source-agent.js";

const OUTPUT = JSON.stringify({
  title: "Statements Module",
  targetPath: "statements/overview.md",
  markdown: "---\ntitle: Statements Module\nstatus: draft\n---\n\n# Statements\n\nGrounded content.",
  rationale: "Grounded in s1/readme.md."
});

function seedJob(): JobView {
  return {
    id: "job-1",
    type: "draft_seed_document",
    input: {
      provider: "openai-compatible",
      flowId: "f1",
      coverage: ["statement ingestion"],
      sources: [{ id: "s1", name: "Repo", kind: "local", path: "unused-here" }]
    }
  } as JobView;
}

describe("runSourceAgentJob", () => {
  it("lets the model read a source file and returns the parsed job output", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "magpie-agent-"));
    writeFileSync(path.join(root, "readme.md"), "statements are ingested via email and API");
    const model = scriptedModel([
      { toolCall: { toolName: "read_file", input: { path: "s1/readme.md" } } },
      { text: OUTPUT }
    ]);
    const result = await runSourceAgentJob({
      job: seedJob(),
      model,
      workspaces: [{ sourceId: "s1", name: "Repo", rootDir: root }],
      notes: [],
      signal: new AbortController().signal
    });
    assert.equal((result as { title: string }).title, "Statements Module");
  });
});
```

Implement `scriptedModel` in the test file with the AI SDK mock-model class: each scripted entry produces one `doGenerate` response — a tool-call content part for `toolCall` entries, a text part for `text` entries (consult `ai/test` typings for the exact response shape: `{ content: [...], finishReason, usage, warnings }`). This is the step where the installed SDK's real API gets pinned; adjust the mock construction to the typings, not from memory.

- [ ] **Step 4: Run to verify failure**

Run: `npm run build && npm test -w apps/watcher`
Expected: FAIL — `./source-agent.js` not found.

- [ ] **Step 5: Implement `apps/watcher/src/runners/source-agent.ts`**

```ts
import { generateText, stepCountIs, tool, type LanguageModel, type ModelMessage } from "ai";
import { z } from "zod";
import type { JobView } from "@magpie/jobs";
import { JOB_RUNNER_SYSTEM } from "@magpie/prompts";
import { buildSourceGroundedPrompt, parseJobOutput } from "../job-prompts.js";
import { logger } from "../logger.js";
import {
  grepWorkspaces,
  listDir,
  readFile,
  SourceToolError,
  type ToolBudget
} from "../source-tools.js";
import type { SourceWorkspace } from "../source-workspace.js";

const MAX_STEPS = 24;
const TOTAL_READ_BUDGET_BYTES = 400_000;

// The HTTP-provider execution tier for source-grounded jobs: a bounded
// generateText tool loop over the read-only source tools. The CLI tier does not
// come through here — agent CLIs traverse the checkout natively (see cli.ts).
// Tool failures are returned to the model as error strings so it can correct
// course; only infrastructure failures reject.
export async function runSourceAgentJob(options: {
  job: JobView;
  model: LanguageModel;
  workspaces: SourceWorkspace[];
  notes: string[];
  signal: AbortSignal;
}): Promise<unknown> {
  const { job, model, workspaces, notes, signal } = options;
  const budget: ToolBudget = { remainingBytes: TOTAL_READ_BUDGET_BYTES };
  const asToolResult = async (run: () => Promise<string>): Promise<string> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof SourceToolError) {
        return `ERROR: ${error.message}`;
      }
      throw error;
    }
  };

  const tools = {
    list_dir: tool({
      description:
        'List a directory. Path is "<sourceId>/<relative path>"; pass "" to list the available sources.',
      inputSchema: z.object({ path: z.string() }),
      execute: ({ path: requested }) => asToolResult(() => listDir(workspaces, requested))
    }),
    read_file: tool({
      description:
        'Read a text file. Path is "<sourceId>/<relative path>". Large files are returned in 32KB slices; re-call with offset to continue.',
      inputSchema: z.object({ path: z.string(), offset: z.number().int().min(0).optional() }),
      execute: ({ path: requested, offset }) => asToolResult(() => readFile(workspaces, requested, budget, offset ?? 0))
    }),
    grep: tool({
      description:
        'Search file contents across all sources with a case-insensitive regular expression. Optional glob filters paths (e.g. "s1/docs/**").',
      inputSchema: z.object({ pattern: z.string(), glob: z.string().optional() }),
      execute: ({ pattern, glob }) => asToolResult(() => grepWorkspaces(workspaces, pattern, glob))
    })
  };

  const prompt = buildSourceGroundedPrompt(job, workspaces, notes, "tools");
  const result = await generateText({
    model,
    system: JOB_RUNNER_SYSTEM.instructions,
    prompt,
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
    abortSignal: signal
  });
  logger.debug(
    { jobId: job.id, steps: result.steps.length, budgetLeft: budget.remainingBytes },
    `${job.type}[${job.id}]: source-agent loop finished in ${result.steps.length} step(s)`
  );

  try {
    return parseJobOutput(job, result.text);
  } catch (error) {
    // The loop hit the step cap mid-exploration (or replied with prose). One
    // forced, tool-less closing turn — the same convergence guarantee the answer
    // loop's forceAnswer gives.
    logger.warn({ jobId: job.id, err: error instanceof Error ? error.message : String(error) }, "forcing final answer after loop output did not parse");
    const messages: ModelMessage[] = [
      ...result.response.messages,
      {
        role: "user",
        content:
          "You have gathered enough. Produce the FINAL JSON output now, exactly matching the required shape. JSON only — no prose, no further exploration."
      }
    ];
    const forced = await generateText({ model, system: JOB_RUNNER_SYSTEM.instructions, messages, abortSignal: signal });
    return parseJobOutput(job, forced.text);
  }
}
```

(Adjust `ModelMessage`/`result.response.messages` member names to the installed v5 typings if they differ — pin against `node_modules/ai`, not memory.)

- [ ] **Step 6: Dispatch from `ChatRunner`**

Rewrite `apps/watcher/src/runners/chat.ts`:

```ts
import type { ChatProvider } from "@magpie/core";
import type { LanguageModel } from "ai";
import type { JobCapability, JobType, JobView } from "@magpie/jobs";
import type { WatcherApi } from "../http-client.js";
import { logger } from "../logger.js";
import { hasFsSources, prepareSourceWorkspaces, sourceDescriptorsOf } from "../source-workspace.js";
import { PROVIDER_JOB_TYPES, runGenerativeJob } from "./generative.js";
import { runSourceAgentJob } from "./source-agent.js";

// Runs AI jobs through an OpenAI-compatible or Azure OpenAI chat provider. The
// capability (openai-compatible / azure-openai) is whatever queue the watcher
// claimed from, so the API has already matched provider to runner. Source-grounded
// jobs with filesystem-backed sources run the agentic tool loop over their source
// workspaces; everything else runs the one-shot generative path.
export class ChatRunner {
  constructor(
    readonly capability: Extract<JobCapability, "openai-compatible" | "azure-openai">,
    private readonly chat: ChatProvider,
    private readonly api: WatcherApi,
    private readonly agentModel?: LanguageModel,
    private readonly checkoutRoot: string = process.env.MAGPIE_CHECKOUT_ROOT ?? ".magpie/checkouts",
    private readonly prepareWorkspaces: typeof prepareSourceWorkspaces = prepareSourceWorkspaces
  ) {}

  supports(type: JobType): boolean {
    return PROVIDER_JOB_TYPES.has(type);
  }

  async run(job: JobView, signal: AbortSignal): Promise<unknown> {
    const descriptors = sourceDescriptorsOf(job);
    if (hasFsSources(descriptors) && this.agentModel) {
      const { workspaces, notes } = await this.prepareWorkspaces(descriptors, { checkoutRoot: this.checkoutRoot });
      logger.info(
        { jobId: job.id, workspaceCount: workspaces.length },
        `${job.type}[${job.id}]: running source-agent loop over ${workspaces.length} workspace(s)`
      );
      return runSourceAgentJob({ job, model: this.agentModel, workspaces, notes, signal });
    }
    return runGenerativeJob({ job, model: this.chat, api: this.api, signal });
  }
}
```

- [ ] **Step 7: Build the language model in `runners/index.ts`**

In `createConfiguredRunners`, extend the two `ChatRunner` constructions:

```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAzure } from "@ai-sdk/azure";

// inside ready("openai-compatible"):
const openaiAgentModel = createOpenAICompatible({
  name: "openai-compatible",
  baseURL: env.OPENAI_COMPATIBLE_BASE_URL ?? "",
  ...(env.OPENAI_COMPATIBLE_API_KEY ? { apiKey: env.OPENAI_COMPATIBLE_API_KEY } : {})
}).chatModel(env.OPENAI_COMPATIBLE_MODEL ?? "");
runners.push(new ChatRunner("openai-compatible", createChatProvider({ ...as today... }), api, openaiAgentModel));

// inside ready("azure-openai"):
const azureAgentModel = createAzure({
  ...(env.AZURE_OPENAI_API_KEY ? { apiKey: env.AZURE_OPENAI_API_KEY } : {}),
  baseURL: env.AZURE_OPENAI_ENDPOINT ?? "",
  ...(env.AZURE_OPENAI_API_VERSION ? { apiVersion: env.AZURE_OPENAI_API_VERSION } : {})
})(env.AZURE_OPENAI_CHAT_DEPLOYMENT ?? "");
runners.push(new ChatRunner("azure-openai", createChatProvider({ ...as today... }), api, azureAgentModel));
```

The readiness gates guarantee these env vars are set when the branch runs — but do not use non-null assertions; the `?? ""` fallbacks are unreachable and keep the types honest. **Verify the `createAzure` option names against the installed `@ai-sdk/azure`** (`baseURL` vs `resourceName`; whether `apiVersion` exists) and adjust — Azure endpoints in this repo are full endpoints (`https://<res>.openai.azure.com`), so prefer the baseURL-style option if both exist.

- [ ] **Step 8: Extend `chat.test.ts`**

Add a test: a `draft_seed_document` job with a `local`-kind source dispatches to the agent path (inject a fake `prepareWorkspaces` returning a fixture workspace and a scripted mock model that immediately returns valid output JSON), while an `answer_question` job still routes through `runGenerativeJob` (existing tests cover this — just confirm they still pass with the two new optional constructor args defaulted).

- [ ] **Step 9: Run everything, then commit**

Run: `npm run build && npm test -w apps/watcher && npm run typecheck && npm run lint && npm run deadcode`
Expected: PASS.

```bash
git add -A
git commit -m "feat(watcher): Vercel AI SDK source-agent loop for HTTP providers"
git push
```

---

### Task 6: Tier 1 — CLI providers traverse the checkout

**Files:**
- Modify: `apps/watcher/src/runners/cli.ts`
- Modify: `apps/watcher/src/runners/index.ts` (pass `agenticTimeoutMs` from `MAGPIE_AGENTIC_TIMEOUT_MS`)
- Modify: `packages/jobs/src/catalog.ts` (check `draft_seed_document` queue policy expiration covers 10-minute runs)
- Test: extend `apps/watcher/src/runners/cli.test.ts`

**Interfaces:**
- Consumes: `prepareSourceWorkspaces`, `hasFsSources`, `sourceDescriptorsOf` (Tasks 2/5), `buildSourceGroundedPrompt` (Task 3).
- Produces: `CliRunnerOptions` gains `agenticTimeoutMs?: number` (default 600_000), `prepareWorkspaces?: typeof prepareSourceWorkspaces`, and a `spawnOverride` test seam typed like `node:child_process.spawn`.

- [ ] **Step 1: Check the queue policy**

Read `packages/jobs/src/catalog.ts` for `draft_seed_document`'s queue policy (pg-boss `expireInSeconds`/`expiration`). If the job would expire before 15 minutes, raise it to 900 seconds for this type with a comment referencing agentic runtimes. If policy already ≥ 15 min, no change — note that in the commit message.

- [ ] **Step 2: Write the failing CliRunner tests**

In `apps/watcher/src/runners/cli.test.ts`, add a describe block using a `spawnOverride` seam (added in Step 3) that captures `(command, args, options)` and emits scripted stdout + exit 0 via a fake child (mirror how existing tests fake children; if they spawn real processes, build a minimal EventEmitter-based fake child — `stdout`/`stderr` emitters, `stdin.end`, `kill`, `close` event):

```ts
it("runs draft_seed_document inside the source workspace with read-only claude flags", async () => {
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const runner = new CliRunner({
    capability: "claude",
    command: "claude",
    args: ["-p"],
    promptMode: "arg",
    api: fakeApi(),
    agenticTimeoutMs: 600_000,
    prepareWorkspaces: async () => ({
      workspaces: [{ sourceId: "s1", name: "Repo", rootDir: "/checkouts/s1" }],
      notes: []
    }),
    spawnOverride: fakeSpawn(calls, OUTPUT_JSON)
  });
  await runner.run(seedJob(), new AbortController().signal);
  assert.equal(calls[0]!.cwd, "/checkouts/s1");
  assert.ok(calls[0]!.args.includes("--allowedTools"));
  assert.ok(calls[0]!.args.includes("Read,Grep,Glob"));
});

it("passes --sandbox read-only for codex and lists extra workspaces in the prompt", async () => {
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const runner = new CliRunner({
    capability: "codex",
    command: "codex",
    args: ["exec"],
    promptMode: "arg",
    api: fakeApi(),
    prepareWorkspaces: async () => ({
      workspaces: [
        { sourceId: "s1", name: "Repo", rootDir: "/checkouts/s1" },
        { sourceId: "s2", name: "Docs", rootDir: "/checkouts/s2" }
      ],
      notes: []
    }),
    spawnOverride: fakeSpawn(calls, OUTPUT_JSON)
  });
  await runner.run(seedJob(), new AbortController().signal);
  assert.deepEqual(calls[0]!.args.slice(1, 3), ["--sandbox", "read-only"]);
  const promptArg = calls[0]!.args.at(-1)!;
  assert.match(promptArg, /\/checkouts\/s2/);
});

it("keeps the plain path for seed jobs with only non-fs sources", async () => {
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const runner = new CliRunner({
    capability: "claude",
    command: "claude",
    args: ["-p"],
    promptMode: "arg",
    api: fakeApi(),
    prepareWorkspaces: async () => {
      throw new Error("must not be called for non-fs sources");
    },
    spawnOverride: fakeSpawn(calls, OUTPUT_JSON)
  });
  const job = seedJob();
  (job.input as { sources: unknown }).sources = [{ id: "i1", name: "Site", kind: "internet", url: "https://x.example" }];
  await runner.run(job, new AbortController().signal);
  assert.equal(calls[0]!.cwd, undefined);
  assert.equal(calls[0]!.args.includes("--allowedTools"), false);
});
```

`OUTPUT_JSON` is the same valid `draft_seed_document` output JSON used in Task 5's test. `seedJob()` as in Task 5.

- [ ] **Step 3: Run to verify failure, then implement**

Run: `npm test -w apps/watcher` → FAIL (no `spawnOverride`/`prepareWorkspaces` options).

Implement in `cli.ts`:

1. Extend `CliRunnerOptions`:

```ts
import type { spawn as nodeSpawn } from "node:child_process";
import type { SourceDescriptor } from "@magpie/core";
import { buildSourceGroundedPrompt } from "../job-prompts.js";
import { hasFsSources, prepareSourceWorkspaces, sourceDescriptorsOf, type PreparedSources } from "../source-workspace.js";

export interface CliRunnerOptions {
  // ...existing fields...
  // Timeout for source-grounded agentic runs (exploration takes minutes, not the
  // 120s a one-shot completion needs).
  agenticTimeoutMs?: number;
  checkoutRoot?: string;
  prepareWorkspaces?: typeof prepareSourceWorkspaces;
  // Test seam: capture/fake process spawning.
  spawnOverride?: typeof nodeSpawn;
}
```

Defaults in the constructor: `agenticTimeoutMs ?? 600_000`, `checkoutRoot ?? process.env.MAGPIE_CHECKOUT_ROOT ?? ".magpie/checkouts"`, `spawnOverride ?? spawn`, `prepareWorkspaces ?? prepareSourceWorkspaces`.

2. Branch in `run()` BEFORE `runGenerativeJob` (source-grounded jobs never go through the ChatProvider adapter — the CLI is the whole agent for them):

```ts
async run(job: JobView, signal: AbortSignal): Promise<unknown> {
  const descriptors = sourceDescriptorsOf(job);
  if (hasFsSources(descriptors)) {
    return this.runSourceGrounded(job, descriptors, signal);
  }
  // ...existing runGenerativeJob path...
}

private async runSourceGrounded(job: JobView, descriptors: SourceDescriptor[], signal: AbortSignal): Promise<unknown> {
  const prepared = await this.prepareWorkspaces(descriptors, { checkoutRoot: this.checkoutRoot });
  const prompt = buildSourceGroundedPrompt(job, prepared.workspaces, prepared.notes, "cli");
  const primary = prepared.workspaces[0]!;
  const content = await this.spawnCli(prompt, signal, {
    cwd: primary.rootDir,
    extraArgs: this.readOnlyArgs(prepared),
    timeoutMs: this.agenticTimeoutMs
  });
  return parseJobOutput(job, content);
}

// Read-only enforcement is assembled HERE, per capability, so it cannot be
// dropped by operator arg configuration.
private readOnlyArgs(prepared: PreparedSources): string[] {
  if (this.capability === "claude") {
    const extraDirs = prepared.workspaces.slice(1).flatMap((ws) => ["--add-dir", ws.rootDir]);
    return ["--allowedTools", "Read,Grep,Glob", ...extraDirs];
  }
  return ["--sandbox", "read-only"];
}
```

`parseJobOutput` is already imported into this module's neighbourhood via `generative.ts`; import it directly from `../job-prompts.js`.

3. Extend `spawnCli(prompt, signal, opts?: { cwd?: string; extraArgs?: string[]; timeoutMs?: number })`: insert `extraArgs` after the configured args and before the model/prompt args; pass `cwd` in the spawn options (`this.spawnFn(this.command, args, { stdio: ["pipe", "pipe", "pipe"], ...(opts?.cwd ? { cwd: opts.cwd } : {}) })`); use `opts?.timeoutMs ?? this.timeoutMs` for the timer.

4. **Flag verification step (spec deferral):** run `claude --help` and `codex exec --help` against the locally installed CLIs and confirm the exact spellings (`--allowedTools` vs `--allowed-tools`; `--add-dir`; `--sandbox read-only`). Correct `readOnlyArgs` to the real flags and record the verified spellings + CLI versions in a comment above `readOnlyArgs`. If a CLI is not installed locally, keep the researched spelling and flag it in the PR description as needing a deploy-environment check.

- [ ] **Step 4: Wire the timeout env and run**

In `runners/index.ts`, pass to both `CliRunner`s: `agenticTimeoutMs: positiveInt(env.MAGPIE_AGENTIC_TIMEOUT_MS, 600_000)`. If the repo has a `.env.example`, add `MAGPIE_AGENTIC_TIMEOUT_MS=600000` with a one-line comment.

Run: `npm run build && npm test -w apps/watcher && npm test -w packages/jobs && npm run typecheck && npm run lint && npm run deadcode`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(watcher): CLI providers explore source checkouts read-only for seeding"
git push
```

---

### Task 7: End-to-end validation and docs

**Files:**
- Modify: `docs/architecture.md`, `docs/ai-jobs.md`
- Modify: `.claude/skills/magpie-orientation/SKILL.md` (source-material notes)
- Possibly modify: `scripts/e2e-jobs.ts` (only if it enqueues `draft_seed_document` with the old input shape)

- [ ] **Step 1: Full validation suite**

Run, in order: `npm run build && npm run typecheck && npm run lint && npm run format:check && npm test && npm run deadcode`
Expected: all PASS. Then `npm run test:db` (needs `DOCKER_HOST` set to the Docker Desktop Linux-engine pipe on this machine — see the writing-magpie-tests skill; the cli.test stdin test is a known Windows failure, ignore only that one if it appears).

- [ ] **Step 2: Grep for stale references**

Run: `rg -l "sourceContext" apps/api/src/features/seed packages/prompts` — expect no hits.
Run: `rg -l "draft_seed_document" scripts/` — if `scripts/e2e-jobs.ts` builds a seed input, update it to the descriptor shape.

**Coverage decision (spec deviation, recorded):** the spec asks for a Postgres-gated integration test seeding from a fixture git repo. The end-to-end gate here is the queue e2e script (updated above) plus the fixture-git workspace tests (Task 2) and the scripted-model loop test (Task 5), which together cover the same path without a bespoke PG harness. If the queue e2e does not already exercise seeding, extend it with a seed case that uses a `local`-kind fixture source and the deterministic provider fixture — that is the preferred place for this coverage, not a new PG-gated test.

- [ ] **Step 3: Update docs**

- `docs/ai-jobs.md`: update the `draft_seed_document` entry — input now carries `sources: SourceDescriptor[]`; execution is agentic (CLI tier: read-only checkout traversal; HTTP tier: bounded tool loop). Note the 10-minute agentic timeout env (`MAGPIE_AGENTIC_TIMEOUT_MS`).
- `docs/architecture.md`: in the watcher section, note that the shared checkout volume now also hosts *source* checkouts for source-grounded jobs, and that seeding no longer samples sources API-side. Reference the spec (`docs/superpowers/specs/2026-07-06-source-agentic-grounding-design.md`).
- `.claude/skills/magpie-orientation/SKILL.md`: amend the "watcher has no database access" implication bullet to mention source workspaces alongside the managed-checkout volume, and note seeding's agentic grounding (one sentence each; don't restructure the skill).

- [ ] **Step 4: Commit and push**

```bash
git add -A
git commit -m "docs: source-agentic seeding — job contract, architecture, orientation notes"
git push
```

- [ ] **Step 5: Open the PR**

```bash
gh pr create --base main --title "feat: source-agentic grounding for seeding (increment 1)" --body "Implements increment 1 of docs/superpowers/specs/2026-07-06-source-agentic-grounding-design.md: draft_seed_document carries source descriptors; watcher resolves them to shared-volume workspaces; claude/codex CLIs traverse read-only in-checkout; openai-compatible/azure get a bounded Vercel AI SDK tool loop (list_dir/read_file/grep, path-confined). Fails loudly when no fs source resolves. Increments 2 (gap drafting) and 3 (patrols + sampler deletion) follow."
```

Flag in the PR body any CLI flag spellings that could not be verified locally (Task 6 Step 3.4).
