# MVP Plan

## Milestone 1: Cited Answers

- Configure one Git-backed Markdown repository.
- Sync repository locally.
- Parse Markdown files and frontmatter.
- Split documents into stable heading-based sections.
- Store sections in Postgres.
- Add keyword search and mock embeddings.
- Answer questions with citations from retrieved sections.
- Expose `ask` and `search` over HTTP and MCP.
- Support mock and queued AI execution modes.

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
