# Markdown Magpie — agent guide

Git-backed Markdown knowledge maintenance system. npm-workspace monorepo, Node ≥22.12,
ESM/NodeNext, TypeScript.

## Start here

- **Doing development work on this repo?** Invoke the **`magpie-orientation`** skill first.
  It explains the queue-only AI model, where code lives (`apps/` and `packages/`), and the
  project conventions and gotchas.
- **Running / smoke-testing the stack?** Invoke the **`run-magpie`** skill for the launch
  recipe (Postgres → migrate → API → Watcher → Web, with the local `.env` overrides).

Both live under `.claude/skills/`. Don't re-derive what they cover.

## Non-negotiables (the rest are in magpie-orientation)

- **AI work is queue-only.** The API never calls a model inline — it enqueues a job; the
  watcher claims it, calls back into the API for scoped context, invokes the provider, and
  posts the result back. Never add an inline provider call in the API.
- **Never cast through `unknown`** (or `any`) to silence types — fix the types properly.
- **No hacky workarounds** — fix the root cause the best way.
- **Validate as you go** (`npm run build`, `npm test`, `npm run typecheck`, `npm run lint`)
  — don't batch a large change and validate once.
- **Commit and push little and often.**
- **Update documentation** alongside code changes.
