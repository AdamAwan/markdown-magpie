# `markdown-magpie` Claude Code plugin

Installs the Markdown Magpie MCP server **and** the skills for using it well, in one step.
Without the skills, a client gets eleven `kb_*` tools and no idea that `kb_ask` is a queued
job, that `kb_outline` only proposes, or that approving a questionnaire answer writes into
a reuse corpus.

## What's in it

| Component | What it does |
| --- | --- |
| `.mcp.json` | Registers the `markdown-magpie` MCP server (Streamable HTTP) |
| `skills/asking-magpie` | `kb_ask` vs `kb_search`, flows, follow-ups, citations, feedback |
| `skills/seeding-a-flow` | `kb_outline` → review → `kb_seed`, and the charter/persona trap |
| `skills/magpie-questionnaires` | Batch answering, the polling loop, and the approval gate |

## Install

```bash
claude plugin marketplace add AdamAwan/markdown-magpie
claude plugin install markdown-magpie@markdown-magpie
```

Or from a checkout of this repository:

```bash
claude plugin marketplace add .
claude plugin install markdown-magpie@markdown-magpie
```

If the install summary says `Run /reload-plugins to activate.`, run it — that loads the
skills without restarting.

## Point it at your Magpie

The plugin defaults to a local HTTP MCP server at `http://localhost:4001/mcp`. For a hosted
deployment, set `MAGPIE_MCP_URL` in the environment Claude Code runs in:

```bash
export MAGPIE_MCP_URL=https://magpie.example.com/mcp
```

The endpoint is an OAuth protected resource (unless the operator set `AUTH_REQUIRED=false`),
so Claude Code prompts you to authenticate on first use. Per-tool scopes still apply — see
[`docs/mcp.md`](../../docs/mcp.md#authentication--authorization).

The server also needs a running API **and a watcher**: `kb_ask`, `kb_outline`, `kb_seed`
and questionnaire answering are all queued jobs that never complete without one.

## Local stdio instead

Developers working in this repository already get the stdio server from the project-scoped
`.mcp.json` at the repository root — installing the plugin as well would register the same
tools twice. Either use the repo's `.mcp.json` (stdio, no auth locally) or the plugin
(HTTP), not both.

## Developing the plugin

```bash
claude --plugin-dir ./plugin/markdown-magpie   # load without installing
claude plugin validate ./plugin/markdown-magpie
```

Skills are Markdown only — there is nothing to build, and `/reload-plugins` picks up edits.
