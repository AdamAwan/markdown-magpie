# Watcher Git Readiness and Local Checkout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent GitHub-capable watchers from claiming work without Git and make remote watchers publish from their own managed checkout.

**Architecture:** Capability derivation receives a small runtime-dependency object whose Git probe executes `git --version`. The publication runner receives a repository-preparation dependency backed by `ensureGitCheckout`, then rewrites API-host paths to watcher-local paths before invoking the existing publisher.

**Tech Stack:** TypeScript, Node.js `child_process`, Node test runner, `@magpie/git`, Zod

---

### Task 1: Gate GitHub Capability on Git Availability

**Files:**
- Modify: `apps/watcher/src/capabilities.test.ts`
- Modify: `apps/watcher/src/capabilities.ts`
- Modify: `apps/watcher/src/main.ts`
- Modify: `apps/watcher/src/runners/index.ts`

- [ ] **Step 1: Write the failing capability tests**

Add tests that pass `{ gitAvailable: () => false }` and assert complete GitHub credentials do not advertise `github`, then pass `{ gitAvailable: () => true }` and assert they do. Preserve existing environment-gate assertions by using the successful probe explicitly.

- [ ] **Step 2: Run the capability test to verify it fails**

Run: `npm test -w @magpie/watcher -- --test-name-pattern='github'`

Expected: FAIL because `deriveCapabilities` does not accept or consult a Git probe.

- [ ] **Step 3: Implement the Git probe and dependency-aware gates**

Add a `CapabilityRuntime` interface, an `isGitAvailable()` implementation using `spawnSync("git", ["--version"])`, and a default runtime. Change gate `ready` functions and `deriveCapabilities` to accept the runtime. Make the GitHub gate require both its environment variables and `runtime.gitAvailable()`.

Pass the same runtime through `createConfiguredRunners` so runner construction and advertised capabilities cannot disagree. Update startup readiness logging to use the runtime and report `Git executable: available/MISSING`.

- [ ] **Step 4: Run capability and watcher tests**

Run: `npm test -w @magpie/watcher`

Expected: PASS.

### Task 2: Prepare a Watcher-Local Checkout Before Publication

**Files:**
- Modify: `apps/watcher/src/runners/publication.test.ts`
- Modify: `apps/watcher/src/runners/publication.ts`

- [ ] **Step 1: Write failing publication tests**

Extend `PublicationDeps` test fixtures with `prepareRepository`. Assert proposal, crunch, and source-sync jobs call it and that publishers receive its watcher-local `localPath`, `git.workTreeRoot`, and subdirectory-aware `git.indexedPath`. Add a test asserting an explicit failure when neither repository remote URL is available.

- [ ] **Step 2: Run publication tests to verify they fail**

Run: `npm test -w @magpie/watcher -- --test-name-pattern='prepares|remote URL'`

Expected: FAIL because publication currently forwards API-host paths directly.

- [ ] **Step 3: Implement checkout preparation**

Add `prepareRepository(repository)` to `PublicationDeps`. In production, resolve the remote URL, call `ensureGitCheckout` with `MAGPIE_CHECKOUT_ROOT ?? ".magpie/checkouts"`, the repository ID, and default branch, then return a `RepositoryRef` whose local filesystem fields use the checkout path while preserving `relativePathFromRoot`.

Call preparation once after parsing each execution context and pass the prepared repository to the publisher. Keep PR base-branch and metadata behavior unchanged.

- [ ] **Step 4: Run publication and watcher tests**

Run: `npm test -w @magpie/watcher`

Expected: PASS.

### Task 3: Verify the Complete Change

**Files:**
- Verify: `apps/watcher/src/**/*.ts`
- Verify: `packages/git/src/index.ts`

- [ ] **Step 1: Run watcher type checking**

Run: `npm run typecheck -w @magpie/watcher`

Expected: PASS.

- [ ] **Step 2: Run the watcher build**

Run: `npm run build -w @magpie/watcher`

Expected: PASS.

- [ ] **Step 3: Run focused and root verification**

Run: `npm test -w @magpie/watcher && npm run typecheck`

Expected: PASS with no failed tests or TypeScript errors.

- [ ] **Step 4: Review the diff**

Run: `git diff --check && git status --short && git diff --stat`

Expected: no whitespace errors and only the planned watcher/test/documentation files changed.
