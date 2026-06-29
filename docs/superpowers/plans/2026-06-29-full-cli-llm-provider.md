# Full CLI LLM Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `claude` and `codex` CLI watcher providers support the same non-embedding LLM job surface as hosted chat providers.

**Architecture:** Extract the hosted-chat answer/reconcile orchestration into a shared runner helper over a minimal `complete()` model interface. `ChatRunner` will adapt hosted chat providers to that helper, and `CliRunner` will adapt external CLI calls to the same helper while keeping embeddings exclusively in the existing retrieval provider configuration.

**Tech Stack:** TypeScript, Node test runner, watcher package, `@magpie/jobs`, `@magpie/prompts`, `@magpie/retrieval`.

---

### Task 1: Add Failing CLI Coverage

**Files:**
- Modify: `apps/watcher/src/runners/cli.test.ts`

- [ ] **Step 1: Write failing tests**

Add assertions that `CliRunner` supports `answer_question` and `reconcile_gap_clusters`, then add behavior tests showing a Claude CLI runner can route/retrieve/answer and critic-confirm cluster reshapes.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @magpie/watcher -- src/runners/cli.test.ts`
Expected: FAIL because `CliRunner.supports("answer_question")` and `supports("reconcile_gap_clusters")` are currently false.

### Task 2: Extract Shared Generative Orchestration

**Files:**
- Create: `apps/watcher/src/runners/generative.ts`
- Modify: `apps/watcher/src/runners/chat.ts`
- Modify: `apps/watcher/src/runners/cli.ts`
- Modify: `apps/watcher/src/runners/index.ts`

- [ ] **Step 1: Implement shared helper**

Move `answer_question`, `reconcile_gap_clusters`, generic `buildPrompt -> complete -> parseJobOutput`, and shared supported provider job types into `generative.ts`.

- [ ] **Step 2: Wire hosted chat through helper**

Keep `ChatRunner` as the hosted provider adapter, but delegate `run()` and `supports()` to `generative.ts`.

- [ ] **Step 3: Wire CLI through helper**

Make `CliRunner` expose a `complete()` adapter that invokes the external CLI and pass the watcher API into configured CLI runners.

- [ ] **Step 4: Run focused tests**

Run: `npm test -w @magpie/watcher -- src/runners/cli.test.ts src/runners/chat.test.ts`
Expected: PASS.

### Task 3: Verify and Publish

**Files:**
- Modify only implementation and tests above unless typecheck exposes a narrow integration issue.

- [ ] **Step 1: Run package verification**

Run: `npm test -w @magpie/watcher`
Run: `npm run typecheck -w @magpie/watcher`

- [ ] **Step 2: Inspect diff and commit**

Run: `git diff --check`
Stage only the CLI provider changes and plan file. Do not stage unrelated `docs/superpowers/specs/.cursorindexingignore`.

- [ ] **Step 3: Push and open draft PR**

Push `codex/full-cli-llm-provider` and open a draft PR with a body describing the full CLI provider support and verification commands.
