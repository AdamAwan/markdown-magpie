import type {
  AnswerCandidate,
  AnswerQuestionJobOutput,
  Questionnaire,
  QuestionnaireItem,
  QuestionnaireItemCitation,
  QuestionnaireItemOutcome,
  QuestionnaireSummary
} from "@magpie/core";
import type { JobView } from "@magpie/jobs";
import type { AppContext } from "../../context.js";
import { logger } from "../../logger.js";
import { assertAiCapacity } from "../../platform/ai-capacity.js";
import { buildAnswerQuestionInput, recordAnswerQuestionLog } from "../../platform/answer-question.js";
import { embeddingModelId } from "../../platform/providers.js";
import { retrieve } from "../retrieve/service.js";
import { isFastPathReusable } from "./reconcile.js";
import { checkReuse, type ReuseCheckDeps } from "./reuse-check.js";

// Questionnaire mode (docs/questionnaires.md): explicit bulk batches with
// verbatim answer reuse. The item history is the canonical answer store;
// freshness is derived from the KB sections each answer cited — never a TTL.

export type CreateQuestionnaireResult =
  { ok: true; questionnaire: Questionnaire } | { ok: false; code: "flow_not_found" | "empty_questionnaire" };

export async function createQuestionnaire(
  ctx: AppContext,
  input: { name: string; flowId: string; questions: string[] }
): Promise<CreateQuestionnaireResult> {
  if (!ctx.knowledgeConfig.flows.some((flow) => flow.id === input.flowId)) {
    return { ok: false, code: "flow_not_found" };
  }
  const questions = input.questions.map((question) => question.trim()).filter((question) => question.length > 0);
  if (questions.length === 0) {
    return { ok: false, code: "empty_questionnaire" };
  }

  const created = await ctx.stores.questionnaires.create({ name: input.name, flowId: input.flowId, questions });

  // Match phase — embeddings are the sanctioned inline exception. With no
  // embedding provider configured, matching degrades to "everything is fresh"
  // (mirroring keyword-only retrieval); items still answer normally.
  const embedding = ctx.providers.embedding;
  const model = embeddingModelId(ctx.settings);
  if (embedding && model) {
    try {
      const vectors = await embedding.embed(created.items.map((item) => item.question));
      await ctx.stores.questionnaires.setItemEmbeddings(
        created.items.map((item, index) => ({ itemId: item.id, embedding: vectors[index], model }))
      );
      const deps = reuseCheckDeps(ctx, input.flowId);
      const threshold = ctx.settings.questionnaires.matchThreshold;
      for (const [index, item] of created.items.entries()) {
        if (ctx.settings.questionnaires.reconcileEnabled) {
          const k = ctx.settings.questionnaires.reconcileCandidates;
          const candidates = await ctx.stores.questionnaires.matchApprovedTopN(
            input.flowId,
            vectors[index],
            model,
            k
          );
          const above = candidates.filter((c) => c.similarity >= threshold);
          if (above.length === 0) {
            continue; // fresh via drip
          }
          if (above.length === 1) {
            const decision = await checkReuse(deps, above[0]!.item, item.question);
            if (isFastPathReusable(1, decision)) {
              await ctx.stores.questionnaires.markReused(item.id, {
                itemId: above[0]!.item.id,
                answer: above[0]!.item.answer ?? "",
                // The ORIGINAL generation time carries forward — the freshness
                // baseline for the next questionnaire's newcomer check.
                answeredAt: above[0]!.item.answeredAt ?? ""
              });
              continue;
            }
          }
          // 2+ candidates, or a single changed one → reconcile: stash
          // candidate ids for the drip to prime the answer_question job.
          await ctx.stores.questionnaires.setReconcileCandidates(
            item.id,
            above.map((c) => c.item.id)
          );
          continue;
        }
        const match = await ctx.stores.questionnaires.matchApproved(input.flowId, vectors[index], model);
        if (!match || match.similarity < threshold) {
          continue;
        }
        const decision = await checkReuse(deps, match.item, item.question);
        if (decision.reuse) {
          await ctx.stores.questionnaires.markReused(item.id, {
            itemId: match.item.id,
            answer: match.item.answer ?? "",
            // The ORIGINAL generation time carries forward — the freshness
            // baseline for the next questionnaire's newcomer check.
            answeredAt: match.item.answeredAt ?? ""
          });
        } else {
          // Stays pending for the drip; the worksheet explains the change.
          await ctx.stores.questionnaires.markChanged(item.id, decision.reason);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // An embed/matching failure must never lose the questionnaire: items
      // simply all answer fresh (the safe, merely-more-expensive direction).
      logger.warn({ err: message, questionnaireId: created.id }, "questionnaire matching degraded; answering fresh");
    }
  }

  await topUpDrip(ctx, created.id);
  const questionnaire = await ctx.stores.questionnaires.get(created.id);
  return { ok: true, questionnaire: questionnaire ?? created };
}

// Worksheet read. Also tops the drip back up: drip state is derived, never
// held in a timer, so an API restart can never wedge a questionnaire — the
// next read (or completion) resumes it.
export async function getQuestionnaire(ctx: AppContext, id: string): Promise<Questionnaire | undefined> {
  const questionnaire = await ctx.stores.questionnaires.get(id);
  if (questionnaire) {
    await topUpDrip(ctx, questionnaire.id);
    return ctx.stores.questionnaires.get(id);
  }
  return questionnaire;
}

export async function listQuestionnaires(ctx: AppContext): Promise<QuestionnaireSummary[]> {
  return ctx.stores.questionnaires.list();
}

// Keeps at most `questionnaires.maxInflight` items of this questionnaire in
// the answer pipeline, enqueueing the next pending item as slots free up. The
// cap keeps a 200-question batch from monopolising the interactive in-flight
// reservation that protects live asks (#240); a full AI-capacity rejection
// stops the drip until the next completion/read resumes it.
async function topUpDrip(ctx: AppContext, questionnaireId: string): Promise<void> {
  const max = ctx.settings.questionnaires.maxInflight;
  while ((await ctx.stores.questionnaires.countAnswering(questionnaireId)) < max) {
    const item = await ctx.stores.questionnaires.nextPending(questionnaireId);
    if (!item) {
      return;
    }
    const questionnaire = await ctx.stores.questionnaires.get(questionnaireId);
    if (!questionnaire) {
      return;
    }
    try {
      await assertAiCapacity(ctx);
    } catch {
      logger.info({ questionnaireId }, "questionnaire drip paused: AI capacity exhausted");
      return;
    }
    const log = await recordAnswerQuestionLog(ctx, item.question, "questionnaire");
    // markAnswering BEFORE the enqueue: if the enqueue fails the item is
    // recovered by the failure path's retry action, whereas the reverse order
    // could double-enqueue an item on a crash between the two writes.
    await ctx.stores.questionnaires.markAnswering(item.id, log.id);
    const candidateIds = await ctx.stores.questionnaires.reconcileCandidateIds(item.id);
    const candidates: AnswerCandidate[] = (
      await Promise.all(candidateIds.map((id) => ctx.stores.questionnaires.itemById(id)))
    )
      .filter((c): c is NonNullable<typeof c> => c !== undefined && Boolean(c.answer))
      .map((c) => ({ itemId: c.id, question: c.question, answer: c.answer ?? "" }));
    const input = buildAnswerQuestionInput(ctx, {
      questionLogId: log.id,
      question: item.question,
      requestedFlowId: questionnaire.flowId,
      ...(candidates.length > 0 ? { candidates } : {})
    });
    await ctx.jobs.create("answer_question", input);
  }
}

// Completion side effect, called by the jobs-service dispatcher right after the
// question log is updated. Not every answer_question belongs to a questionnaire
// — the item lookup by questionLogId is the guard.
export async function handleQuestionnaireAnswerCompletion(
  ctx: AppContext,
  job: JobView | undefined,
  output: AnswerQuestionJobOutput
): Promise<void> {
  const questionLogId = answerJobQuestionLogId(job);
  if (!questionLogId) {
    return;
  }
  const item = await ctx.stores.questionnaires.itemByQuestionLogId(questionLogId);
  if (!item) {
    return;
  }
  // Ungrounded (no citations) is the only "no answer" case. Low/medium/unknown
  // confidence WITH citations is a shown draft, not a suppression — the badge
  // and human approval carry the trust (see 2026-07-17-questionnaire-trust-design).
  let outcome: QuestionnaireItemOutcome | undefined;
  let basisItemIds: string[] | undefined;
  let answer = output.answer;
  let citations = await snapshotCitations(ctx, output);
  let answeredAt = new Date().toISOString();
  if (output.reuse) {
    if (output.reuse.verdict === "reused") {
      // Trust guarantee: copy the approved answer + its citations VERBATIM by
      // id, never the model's echo.
      const basisId = output.reuse.basisItemIds[0];
      const basis = basisId ? await ctx.stores.questionnaires.itemById(basisId) : undefined;
      if (basis?.answer) {
        answer = basis.answer;
        citations = basis.citations;
        // The ORIGINAL generation time carries forward — the freshness
        // baseline for the next questionnaire's newcomer check (matches the
        // fast-path's markReused, which does the same).
        answeredAt = basis.answeredAt ?? answeredAt;
        outcome = output.reuse.verdict;
        basisItemIds = output.reuse.basisItemIds;
      }
      // A "reused" verdict that can't be honored (no basis id, basis not
      // found, or basis has no answer) degrades to a fresh, ungrounded
      // completion — citations stays [] (from output.citations, which the
      // watcher sends empty for reused) so the item lands unanswerable
      // instead of a blank "answered" row with a phantom reuse outcome.
    } else {
      outcome = output.reuse.verdict; // adapted | merged | fresh
      basisItemIds = output.reuse.basisItemIds;
    }
  }
  await ctx.stores.questionnaires.completeItem(questionLogId, {
    answer,
    answeredAt,
    citations,
    unanswerable: citations.length === 0,
    confidence: output.confidence,
    ...(outcome ? { outcome } : {}),
    ...(basisItemIds ? { basisItemIds } : {})
  });
  await topUpDrip(ctx, item.questionnaireId);
}

// Failure side effect: a terminally failed answer job marks its item
// unanswerable (with the error on the worksheet) and frees the drip slot.
export async function handleQuestionnaireAnswerFailure(
  ctx: AppContext,
  job: JobView | undefined,
  message: string
): Promise<void> {
  const questionLogId = answerJobQuestionLogId(job);
  if (!questionLogId) {
    return;
  }
  const item = await ctx.stores.questionnaires.failItem(questionLogId, message);
  if (item) {
    await topUpDrip(ctx, item.questionnaireId);
  }
}

export type ApproveResult = { ok: true } | { ok: false; code: "not_found" | "not_answered" };

// Approval is the human act that admits an answer into the match corpus for
// future questionnaires. The snapshot keeps the GENERATION-TIME content hashes
// (what the answer was actually built from); if the KB has already moved on by
// approval time the item is flagged stale_at_approval — exportable, but it can
// never pass reuse check 1, by construction.
export async function approveItem(ctx: AppContext, questionnaireId: string, itemId: string): Promise<ApproveResult> {
  const questionnaire = await ctx.stores.questionnaires.get(questionnaireId);
  const item = questionnaire?.items.find((candidate) => candidate.id === itemId);
  if (!questionnaire || !item) {
    return { ok: false, code: "not_found" };
  }
  if (item.status !== "answered") {
    return { ok: false, code: "not_answered" };
  }
  const citations =
    item.outcome === "reused" && item.reusedFromItemId
      ? (questionnaire.items.find((candidate) => candidate.id === item.reusedFromItemId)?.citations ??
        (await reusedFromCitations(ctx, item.reusedFromItemId)))
      : item.citations;
  const stale = await isStaleAgainstCurrentSections(ctx, citations);
  await ctx.stores.questionnaires.approveItem(itemId, citations, stale);
  await backfillEmbedding(ctx, item);
  return { ok: true };
}

export async function approveReused(ctx: AppContext, questionnaireId: string): Promise<{ approved: number }> {
  const reused = await ctx.stores.questionnaires.listReusedUnapproved(questionnaireId);
  let approved = 0;
  for (const item of reused) {
    const outcome = await approveItem(ctx, questionnaireId, item.id);
    if (outcome.ok) {
      approved += 1;
    }
  }
  return { approved };
}

// --- internals -----------------------------------------------------------

function answerJobQuestionLogId(job: JobView | undefined): string | undefined {
  if (!job || job.type !== "answer_question") {
    return undefined;
  }
  const input = job.input as { questionLogId?: unknown };
  return typeof input.questionLogId === "string" ? input.questionLogId : undefined;
}

function reuseCheckDeps(ctx: AppContext, flowId: string): ReuseCheckDeps {
  return {
    async fingerprints(sectionIds) {
      // No Postgres knowledge store (memory backend) → no verifiable identity:
      // returning [] reads as "sections missing", which forbids reuse. Safe.
      return ctx.stores.knowledge ? ctx.stores.knowledge.sectionFingerprints(sectionIds) : [];
    },
    async retrieveTopK(question, limit) {
      const result = await retrieve(ctx, { question, flowId, limit });
      return result.ok
        ? result.sections.map((section) => ({
            sectionId: section.sectionId,
            path: section.path,
            heading: section.heading
          }))
        : undefined;
    }
  };
}

// Generation-time citation snapshot for a freshly completed answer: current
// fingerprints ARE generation-time here (the answer just landed). A section the
// fingerprint query can't resolve gets an empty hash, which can never match at
// reuse time — again the safe direction.
async function snapshotCitations(
  ctx: AppContext,
  output: AnswerQuestionJobOutput
): Promise<QuestionnaireItemCitation[]> {
  const fingerprints = ctx.stores.knowledge
    ? await ctx.stores.knowledge.sectionFingerprints(output.citations.map((citation) => citation.sectionId))
    : [];
  const byId = new Map(fingerprints.map((fingerprint) => [fingerprint.sectionId, fingerprint]));
  return output.citations.map((citation) => ({
    sectionId: citation.sectionId,
    contentHash: byId.get(citation.sectionId)?.contentHash ?? "",
    path: citation.path,
    heading: citation.heading,
    excerpt: citation.excerpt
  }));
}

async function isStaleAgainstCurrentSections(
  ctx: AppContext,
  citations: QuestionnaireItemCitation[]
): Promise<boolean> {
  if (citations.length === 0) {
    return true;
  }
  if (!ctx.stores.knowledge) {
    return true;
  }
  const current = await ctx.stores.knowledge.sectionFingerprints(citations.map((citation) => citation.sectionId));
  const byId = new Map(current.map((fingerprint) => [fingerprint.sectionId, fingerprint]));
  return citations.some((citation) => byId.get(citation.sectionId)?.contentHash !== citation.contentHash);
}

// Approved items must be matchable: (re-)embed at approval, idempotently, so a
// creation-time embedding outage can't silently exclude an item from the match
// corpus forever. Skipped (with a warn) when no provider is configured.
async function backfillEmbedding(ctx: AppContext, item: QuestionnaireItem): Promise<void> {
  const embedding = ctx.providers.embedding;
  const model = embeddingModelId(ctx.settings);
  if (!embedding || !model) {
    return;
  }
  try {
    const [vector] = await embedding.embed([item.question]);
    await ctx.stores.questionnaires.setItemEmbeddings([{ itemId: item.id, embedding: vector, model }]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ err: message, itemId: item.id }, "questionnaire approval embedding backfill failed");
  }
}

async function reusedFromCitations(ctx: AppContext, reusedFromItemId: string): Promise<QuestionnaireItemCitation[]> {
  // The reused-from item usually lives in ANOTHER questionnaire, so it is not
  // in the current worksheet's item list; fall back to a direct lookup.
  const prior = await ctx.stores.questionnaires.itemById(reusedFromItemId);
  return prior?.citations ?? [];
}
