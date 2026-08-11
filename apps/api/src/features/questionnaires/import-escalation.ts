import type { QuestionnaireItem, SourceConflictPosition } from "@magpie/core";
import type { AppContext } from "../../context.js";
import { logger } from "../../logger.js";
import { projectSourceDescriptors } from "../../platform/source-descriptors.js";

// Stage 2 of ingesting completed questionnaires
// (docs/superpowers/specs/2026-08-11-questionnaire-ingestion-design.md D5): the
// source-grounded, per-claim check for imported answers whose cheap stage-1
// compare against the KB did not confirm them.

// Bounded exactly as MAX_DRAFTS_PER_TICK bounds gap drafting. A 300-row import
// against a thin knowledge base would otherwise enqueue hundreds of agentic runs
// at once. The remainder is DEFERRED and logged, never dropped: the next drip
// tick or worksheet read drains it, the same derived-state discipline the drip
// itself uses, so an API restart can never wedge an ingestion mid-way.
export const MAX_ESCALATIONS_PER_TICK = 10;

// One finding about one claim, as the stage-2 agent reports it.
export interface ImportFinding {
  kind: "documented-elsewhere" | "contradicted" | "unsubstantiated" | "source-conflict";
  claim: string;
  positions: SourceConflictPosition[];
}

export async function escalateImports(
  ctx: AppContext,
  questionnaireId: string
): Promise<{ enqueued: number; deferred: number }> {
  const questionnaire = await ctx.stores.questionnaires.get(questionnaireId);
  if (!questionnaire) {
    return { enqueued: 0, deferred: 0 };
  }
  // Ask for one more than the cap so "is there more waiting?" is answerable
  // without a second count query.
  const awaiting = await ctx.stores.questionnaires.listAwaitingEscalation(
    questionnaireId,
    MAX_ESCALATIONS_PER_TICK + 1
  );
  const batch = awaiting.slice(0, MAX_ESCALATIONS_PER_TICK);
  const deferred = Math.max(0, awaiting.length - batch.length);

  const flow = ctx.knowledgeConfig.flows.find((candidate) => candidate.id === questionnaire.flowId);
  const sources = projectSourceDescriptors(ctx.repositoryDeps(), flow?.sourceIds);

  let enqueued = 0;
  for (const item of batch) {
    if (!item.importedAnswer) {
      continue;
    }
    await ctx.jobs.create("verify_imported_answer", {
      provider: ctx.config.get().aiProvider,
      itemId: item.id,
      question: item.question,
      importedAnswer: item.importedAnswer,
      // Absent for an `uncovered` item: by definition the KB produced nothing
      // to compare against, and sending an empty string would read as "the KB
      // says nothing on this", which is a different claim.
      ...(item.importVerdict === "divergent" && item.answer ? { kbAnswer: item.answer } : {}),
      sources,
      ...(questionnaire.flowId ? { flowId: questionnaire.flowId } : {})
    });
    // Stamping escalation is what takes the item out of listAwaitingEscalation,
    // so a resumed tick cannot enqueue the same item twice. Deliberately NOT
    // done by overwriting importVerdict: that would make the worksheet report a
    // stage-1 verdict the adjudication never reached.
    await ctx.stores.questionnaires.markImportEscalated(item.id);
    enqueued += 1;
  }

  if (deferred > 0) {
    logger.info(
      { questionnaireId, enqueued, deferred },
      "stage-2 escalation capped for this tick; the remainder drains on a later read or completion"
    );
  }
  return { enqueued, deferred };
}

// Findings fan out by kind.
//
// `documented-elsewhere` is the flywheel: the sources back the claim, the KB
// never wrote it down, so it becomes a knowledge gap and the ordinary reconciler
// drafts a document FROM THE SOURCES. The imported text never reaches the
// drafting agent as content — it set the agenda, nothing more.
//
// `contradicted` and `unsubstantiated` open register entries. `source-conflict`
// belongs to the existing conflict register, not this one: it is a disagreement
// between sources, which Magpie never adjudicates.
export async function routeImportFindings(
  ctx: AppContext,
  item: QuestionnaireItem,
  flowId: string | undefined,
  findings: ImportFinding[]
): Promise<void> {
  for (const finding of findings) {
    if (finding.kind === "documented-elsewhere") {
      if (!item.questionLogId) {
        // No question log means no gap candidacy surface to attach to. Log
        // rather than fail: the register entries in this same batch still land.
        logger.warn({ itemId: item.id }, "documented-elsewhere finding has no question log; gap not raised");
        continue;
      }
      await ctx.stores.questionLogs.recordImportGap(item.questionLogId, {
        summary: finding.claim,
        note: "Raised from an imported questionnaire answer: the sources support this claim but the knowledge base does not record it."
      });
      continue;
    }

    if (finding.kind === "source-conflict") {
      await ctx.stores.sourceConflicts.upsert({
        ...(flowId ? { flowId } : {}),
        // A conflict found while checking an answer is not anchored to a
        // knowledge-base document, so the item stands in as its location.
        documentPath: `questionnaire-item:${item.id}`,
        anchor: "",
        topic: item.question,
        summary: finding.claim,
        claim: finding.claim,
        positions: finding.positions
      });
      continue;
    }

    await ctx.stores.assertedClaims.open({
      ...(flowId ? { flowId } : {}),
      questionnaireId: item.questionnaireId,
      itemId: item.id,
      kind: finding.kind,
      question: item.question,
      claim: finding.claim,
      positions: finding.positions
    });
  }
}

// Completion side effect for a verify_imported_answer job, called by the
// jobs-service dispatcher. Not every job has a live item (a questionnaire can be
// deleted mid-flight), so the lookup is the guard.
export async function handleImportVerificationCompletion(
  ctx: AppContext,
  itemId: string,
  findings: ImportFinding[]
): Promise<void> {
  const item = await ctx.stores.questionnaires.itemById(itemId);
  if (!item) {
    return;
  }
  const questionnaire = await ctx.stores.questionnaires.get(item.questionnaireId);
  await routeImportFindings(ctx, item, questionnaire?.flowId, findings);
}
