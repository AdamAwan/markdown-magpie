# MVP Plan

## Milestone 1: Cited Answers

- Configure one Git-backed Markdown repository.
- Sync repository locally.
- Parse Markdown files and frontmatter.
- Split documents into stable heading-based sections.
- Store sections in Postgres.
- Add hybrid retrieval: pgvector nearest-neighbour fused with keyword scoring via RRF, with automatic keyword-only fallback.
- Answer questions with citations from retrieved sections.
- Expose `ask` and `search` over HTTP and MCP.
- Execute all AI work as durable pg-boss jobs run by capability-filtered watchers.

## Milestone 2: Gap Loop

- Log low-confidence answers.
- Capture user feedback.
- Cluster similar unanswered questions.
- Show gap queue in the web app.
- Generate draft Markdown proposals for top gaps.
- Add a local watcher that can complete proposal jobs through Codex or Claude Code.

## Milestone 3: Pull Requests

- Create branches for proposals.
- Add or edit Markdown files.
- Raise pull requests through a provider adapter.
- Track PR status.
- Re-index after merge.

## Later

- Stale document detection.
- Duplicate section detection.
- Contradiction detection.
- Owner reminders.
- Usage and freshness scoring.
