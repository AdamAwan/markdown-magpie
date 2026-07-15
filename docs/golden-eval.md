# Golden-question regression eval

The golden eval (issue #241) is the answer-quality regression gate: a versioned
set of golden questions asked through the real queue-only pipeline — API,
pg-boss, watcher, retrieval, the agentic answer loop, and grounding
verification — with every model call served by a deterministic fixture, so a
run is exactly reproducible and any score change is caused by a code, prompt
plumbing, or retrieval change.

```bash
npm run eval:golden                      # run + compare against the committed baseline
npm run eval:golden -- --update-baseline # re-pin the baseline after an intended change
```

`eval:golden` wraps `scripts/eval-golden.ts` in `scripts/test-db.mjs`, so it
needs a Docker daemon (for the throwaway pgvector container) and nothing else —
no provider credentials, no embedding endpoint (retrieval runs keyword-only).
CI runs it on every PR (`.github/workflows/verify.yml`, job `golden-eval`).

## Moving parts

| Piece | Path |
|---|---|
| Golden question set (versioned) | `scripts/fixtures/golden-questions.json` |
| Fixture knowledge base (two flows) | `scripts/fixtures/golden-kb/` |
| Deterministic provider | `scripts/fixtures/golden-provider.mjs` + `scripts/lib/golden-core.mjs` |
| Scorer + baseline comparison | `scripts/lib/golden-scoring.mjs` |
| Orchestrator | `scripts/eval-golden.ts` |
| Committed baseline (regression anchor) | `scripts/fixtures/golden-baseline.json` |
| Per-run history (local, gitignored) | `.magpie/eval/golden-history.jsonl` |

The orchestrator boots the provider fixture, the API (with
`KNOWLEDGE_SOURCES`/`DESTINATIONS`/`FLOWS` pointed at the fixture KB), and one
watcher; indexes both flows; asks each case via `POST /api/ask`; waits for the
job and then for the completion side effect to land the answer on the question
log; and scores the stored `QuestionLog`. Process logs for a run land in
`.magpie/eval/*.log`.

## The deterministic provider

`golden-provider.mjs` answers the three call shapes the `answer_question`
pipeline makes, each as a pure function of the request text
(`scripts/lib/golden-core.mjs`):

- **Routing** — picks the flow whose name+persona shares the most content
  words with the question; abstains honestly (`flowId: null`) on zero overlap,
  which exercises the flow-selection-required path.
- **Assess** — parses the retrieved `[section <id>]` context, splits the
  question into clauses (on `", and "`), requests follow-up searches for
  uncovered clauses, and composes answers **only from sentences of sections
  that cover the question**, citing exactly the sections it used. So if
  retrieval stops surfacing the right section, the fixture cannot cite it and
  citation/confidence scores drop — the eval measures the pipeline, not the
  fixture.
- **Verify** — checks every answer sentence appears verbatim in the cited
  context and strips anything unsupported. One deliberate probe: a question
  mentioning SOC 2 makes the assess turn append a fabricated compliance claim,
  which the verify turn must flag — regression-testing the
  claims-stripped/downgrade machinery end to end.

## Dimensions

Aggregated to `[0,1]` over the applicable cases and tracked in the baseline:

- `routing_accuracy` — trace routing mode (+ flow id when expected) matches.
- `confidence_calibration` — shipped confidence equals the expected tier.
- `citation_precision` / `citation_recall` — cited documents vs the case's
  expected documents.
- `groundedness` — computed in code, never trusted from the model: every
  factual answer sentence must appear in the cited documents' text (coverage
  meta-statements are exempt).
- `answer_content` — expected terms present, forbidden terms absent.
- `behaviour_compliance` — gap emission, out-of-scope, flow-selection-required,
  and grounding-verification outcomes match.

## Failing loudly, and re-pinning

A dimension below its baseline value, or a case that passed at baseline time
and fails now, exits non-zero and lists the regressions. Improvements are
printed but do not fail — re-pin with `--update-baseline` and commit the new
baseline (review the diff: a baseline change is a deliberate quality
statement). Changing `scripts/fixtures/golden-questions.json` requires bumping
its `version` and re-pinning; the runner refuses to compare across versions.

## Extending the set

1. Add the knowledge to `scripts/fixtures/golden-kb/<flow>/` (or use what's
   there). Keyword retrieval is Postgres `websearch_to_tsquery` with AND
   semantics — every non-stopword content word of the question must appear
   (stemmed) in the target section for seed retrieval to hit; otherwise the
   case exercises the search-round recovery path instead, which is also fine
   and deterministic.
2. Add the case to `golden-questions.json` and bump `version`.
3. `npm run eval:golden -- --update-baseline`, sanity-check the per-case line
   and the new baseline diff, and commit both.

Related: `scripts/eval-api.ts` (ad-hoc checks against a live deployment) and
`scripts/e2e-jobs.ts` (queue lifecycle smoke test) still exist for their own
jobs; the golden eval is the only one that gates regressions in CI.
