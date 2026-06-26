# Improve Patrol Design

## Summary

Improve-patrol is the slower, editorial patrol from step 5 of the maintenance redesign. It grows fine-but-thin documents using source-backed additions, while fix-patrol remains responsible for correctness and structural cleanup.

The feature adds a separate `improve_patrol` maintenance job and an `improve_document` AI job. Each selected document is sent to the model with only its own content plus the flow's source material. Dedupe and split continue to own multi-file judgement.

## Architecture

`runImprovePatrol` lives beside `runFixPatrol` in the patrol service. It resolves flow scope the same way, selects a small batch with the existing rolling cursor selector, and records a normal patrol run. Its cursor state is separate from fix-patrol by using an explicit cursor kind in the patrol store; existing fix calls default to the fix cursor.

The improve batch is intentionally small: two documents per tick, including one random document. Every selected document enqueues `improve_document`; there is no local thinness prefilter.

## Job And Proposal Flow

`improve_document` input carries `path`, `content`, `sources`, `destinationId`, `flowId`, and provider. Its output is explicit:

```json
{ "improved": true, "markdown": "full document", "rationale": "why this improves coverage" }
```

or:

```json
{ "improved": false, "rationale": "why no clear source-backed growth is useful" }
```

Completion creates a clusterless proposal only when `improved` is true, `markdown` is present, and the markdown differs from the original input. The proposal title starts with `Improve:`, carries `flowId`, `destinationId`, and `jobId`, and targets the same path as the input.

`fold.ts` gets a dedicated `reconcileImproveProposal`, mirroring the single-file corrective path. A touchable same-flow overlap folds through `fold_markdown_proposal`; open-new and approved-overlap/defer publish the improve proposal as its own PR.

## Prompting

The prompt tells the model to grow fine-but-thin documents only when the supplied source material clearly supports the additions. It must preserve structure, avoid dedupe/split/renames/deletes, and return `improved: false` when no useful source-backed addition is available.

## Testing

Implementation follows inline TDD:

- Patrol service test: improve-patrol uses its own cursor and enqueues one improve job per selected document.
- Proposal completion tests: no-op output stays silent; improved output creates an idempotent `Improve:` proposal.
- Fold tests: improve proposals publish when clear, fold into touchable overlaps, and self-publish on approved overlaps.
- Catalog/prompt/runner tests: `improve_document` and `improve_patrol` are registered everywhere jobs, prompts, routes, and scheduled tasks expect them.

## Out Of Scope

Admin targeting of a specific knowledge area is intentionally left for a later PR. Multi-file context and structural cleanup stay with dedupe and split.
