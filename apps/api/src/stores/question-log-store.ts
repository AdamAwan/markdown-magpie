import { randomUUID } from "node:crypto";
import type {
  AnswerResult,
  GapCandidate,
  ParkedQuestion,
  QuestionFeedback,
  QuestionGap,
  QuestionGapSource,
  QuestionLog,
  QuestionLogInput,
  QuestionLogUpdateInput
} from "@magpie/core";

// Gaps carried on an answer, preserving each signal's source ("auto" for a
// whole-question miss, "followup" for missing supporting material a confident
// answer searched for and did not find).
function gapsFromAnswer(answer: AnswerResult | undefined): QuestionGap[] {
  return (answer?.gaps ?? []).map((gap) => ({ summary: gap.summary, source: gap.source }));
}

// Stable map key for a (summary, flowId) gap pair. The flow is coalesced to ''
// (matching how Postgres groups un-routed gaps) and prefixed with its byte
// length so a summary containing the separator can never collide with another
// (flow, summary) pair.
export function gapSummaryKey(summary: string, flowId?: string): string {
  const flow = flowId ?? "";
  return `${flow.length}:${flow}:${summary}`;
}

// Canonical dedupe key for a stored gap row, capturing every field a re-answer's
// delete+reinsert would rewrite: source, trimmed summary, note, and whether it is
// resolved/dismissed. A freshly reinserted answer gap is always unresolved,
// undismissed, and note-less, so a resolved/dismissed row can never key-match a
// fresh one — replacing it would genuinely change the candidate set.
function gapDedupeKey(source: string, summary: string, note: string, resolved: boolean, dismissed: boolean): string {
  return JSON.stringify([source, summary.trim(), note, resolved, dismissed]);
}

// True when re-answering a question would replace its answer-derived (auto +
// followup) gaps with a byte-identical set — same (source, summary) multiset, none
// resolved/dismissed, no stale note. When so, the replace is a no-op: the caller
// skips the delete+reinsert (which would otherwise mint new gap ids and orphan
// cluster memberships) and skips the catalog bump, so a re-answer that changed
// nothing about the candidate gaps no longer forces the reconciler to re-run its
// metered reshape (issue #168). Manual/verification/needs_attention gaps are not
// replaced by the re-answer, so they are excluded from the comparison.
export function answerGapsUnchanged(
  existing: readonly QuestionGap[],
  next: readonly { summary: string; source: QuestionGapSource }[]
): boolean {
  const existingKeys = existing
    .filter((gap) => gap.source === "auto" || gap.source === "followup")
    .map((gap) =>
      gapDedupeKey(gap.source, gap.summary, gap.note ?? "", Boolean(gap.resolvedAt), Boolean(gap.dismissedAt))
    )
    .sort();
  const nextKeys = next.map((gap) => gapDedupeKey(gap.source, gap.summary, "", false, false)).sort();
  if (existingKeys.length !== nextKeys.length) {
    return false;
  }
  return existingKeys.every((key, index) => key === nextKeys[index]);
}

export interface QuestionLogStore {
  record(input: QuestionLogInput): Promise<QuestionLog>;
  updateAnswer(id: string, input: QuestionLogUpdateInput): Promise<QuestionLog | undefined>;
  recordFeedback(id: string, feedback: QuestionFeedback): Promise<QuestionLog | undefined>;
  recordManualGap(id: string, summary?: string): Promise<QuestionLog | undefined>;
  clearManualGap(id: string): Promise<QuestionLog | undefined>;
  // Reopens a gap on a triggering question after a merged proposal failed
  // gap-closure verification. Updates the question's live (unresolved,
  // undismissed) 'verification' gap in place with the latest reopen note (what
  // merged, the re-asked answer, why it is still weak) so a re-draft sees why it
  // is being resubmitted — preserving that gap's id (and any cluster membership
  // keyed off it). When `parked` (retry cap hit) the row is stamped parked_at,
  // escalating the whole question to "awaiting a human" without changing its
  // source. Resolved and dismissed rows are never touched or replaced: they stay
  // retained for audit, and a fresh gap is inserted alongside them only when no
  // live one exists (first-ever failure, or the prior lineage was resolved/dismissed).
  recordVerificationGap(
    id: string,
    gap: { summary: string; note: string; parked: boolean }
  ): Promise<QuestionLog | undefined>;
  // Human "retry" on a parked question: re-admits it to the pipeline. Dismisses
  // the live parked row (reason 'human_retry') — which ends the failed lineage so
  // the retry budget resets (verificationLineageResetSince) — and, if no live gap
  // row still carries the parked summary (the underlying auto gap may have been
  // resolved/dismissed), re-files a fresh live 'verification' row with the note so
  // the re-draft sees why. No-op if the question is not parked.
  retryParkedGap(id: string): Promise<QuestionLog | undefined>;
  // Human "dismiss" on a parked question: abandons the topic by dismissing every
  // live gap row for the question (reason 'human_dismiss'). No-op if not parked.
  dismissParkedGap(id: string): Promise<QuestionLog | undefined>;
  // Questions currently parked (a live parked 'verification' gap), most-recently
  // parked first, for the parked-questions listing surface.
  listParkedQuestions(limit: number): Promise<ParkedQuestion[]>;
  // Soft-resolves the gaps closed by a merged proposal: the matching rows are
  // retained for audit but stop surfacing as candidates. Already-dismissed rows
  // are left untouched — a dismissal is a deliberate settlement a merge must not
  // override. Returns how many gaps were newly resolved.
  resolveGaps(questionIds: string[], summaries: string[], proposalId: string): Promise<number>;
  // Permanently dismisses the given gap rows (by gap id) as off-topic for the
  // knowledge base. Dismissed rows are retained for audit but never surface as
  // candidates or cluster again. Returns how many gaps were newly dismissed.
  dismissGaps(gapIds: string[], reason: string): Promise<number>;
  get(id: string): Promise<QuestionLog | undefined>;
  list(limit: number): Promise<QuestionLog[]>;
  listGapCandidates(limit: number): Promise<GapCandidate[]>;
  // Monotonic counter advanced whenever the unresolved candidate gaps change
  // (added, removed, or resolved). Tracked per flow so a gap change in one flow
  // doesn't force every flow to re-cluster; the reconciler compares its flow's
  // counter to its processed revision to decide whether model work is needed.
  // flowId omitted reads the un-routed/default flow.
  getGapCatalogRevision(flowId?: string): Promise<number>;
  // Stable ids of the unresolved gap rows matching a summary within a flow. The
  // reconciler keys cluster memberships off these. Postgres returns the bigint
  // question_gaps.id; the in-memory store returns a stable synthetic id.
  gapIdsForSummary(summary: string, flowId?: string): Promise<string[]>;
  // Batched gapIdsForSummary: resolves the gap ids for many (summary, flowId)
  // pairs in ONE query so the reconciler avoids the N+1 of calling
  // gapIdsForSummary once per candidate. Returns a map keyed by
  // gapSummaryKey(summary, flowId); every requested pair is present, with an
  // empty array when nothing matches. Ids keep the same ASC ordering as the
  // single-summary variant.
  gapIdsForSummaries(pairs: Array<{ summary: string; flowId?: string }>): Promise<Map<string, string[]>>;
  // Resolves a set of gap ids (as produced by gapIdsForSummary) back to their
  // distinct summaries and question ids, for the cluster read path.
  gapDetailsForIds(gapIds: string[]): Promise<{ summaries: string[]; questionIds: string[] }>;
  // Resolves a set of gap ids to their per-row (questionId, summary) pairs,
  // preserving the row-level association gapDetailsForIds collapses into deduped
  // sets. Used to map a reopened triggering question back to the specific gap
  // summary its proposal's cluster addressed for that question.
  gapPairsForIds(gapIds: string[]): Promise<Array<{ questionId: string; summary: string }>>;
  // The subset of the given gap ids that are still unresolved. Used by the
  // reconciler to prune resolved gaps out of active clusters, and by the draft
  // path to scope a proposal to a cluster's still-open gaps only.
  listUnresolvedGapIds(gapIds: string[]): Promise<string[]>;
  reset(): Promise<void>;
}

export class InMemoryQuestionLogStore implements QuestionLogStore {
  private readonly logs = new Map<string, QuestionLog>();
  // Catalog revision per flow ('' is the un-routed/default flow), mirroring the
  // per-flow gap_catalog table in Postgres.
  private readonly gapCatalogRevision = new Map<string, number>();

  private bumpCatalog(flowId?: string): void {
    const key = flowId ?? "";
    this.gapCatalogRevision.set(key, (this.gapCatalogRevision.get(key) ?? 0) + 1);
  }

  async getGapCatalogRevision(flowId?: string): Promise<number> {
    return this.gapCatalogRevision.get(flowId ?? "") ?? 0;
  }

  async gapIdsForSummary(summary: string, flowId?: string): Promise<string[]> {
    const ids: string[] = [];
    for (const log of this.logs.values()) {
      if ((log.flowId ?? "") !== (flowId ?? "")) {
        continue;
      }
      // Verification re-ask logs (#154) are synthetic — their gap rows never cluster.
      if (log.purpose === "verification") {
        continue;
      }
      // Exclude EVERY gap of a parked question (question-level, matching candidacy)
      // so a parked escalation — or its sibling auto row — is never swept into a
      // cluster where an AI dismissal could discharge it (#158).
      const parked = (log.gaps ?? []).some((gap) => gap.parkedAt && !gap.resolvedAt && !gap.dismissedAt);
      if (parked) {
        continue;
      }
      for (const gap of log.gaps ?? []) {
        if (gap.resolvedAt || gap.dismissedAt || gap.summary !== summary) {
          continue;
        }
        // Synthetic, stable id: the gap row has no surrogate key in memory, so we
        // encode (questionId, summary). gapDetailsForIds parses it back.
        ids.push(`${log.id}::${gap.summary}`);
      }
    }
    return ids;
  }

  async gapIdsForSummaries(pairs: Array<{ summary: string; flowId?: string }>): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    for (const { summary, flowId } of pairs) {
      const key = gapSummaryKey(summary, flowId);
      if (!result.has(key)) {
        result.set(key, await this.gapIdsForSummary(summary, flowId));
      }
    }
    return result;
  }

  async gapDetailsForIds(gapIds: string[]): Promise<{ summaries: string[]; questionIds: string[] }> {
    const summaries = new Set<string>();
    const questionIds = new Set<string>();
    for (const id of gapIds) {
      const sep = id.indexOf("::");
      if (sep === -1) {
        continue;
      }
      questionIds.add(id.slice(0, sep));
      summaries.add(id.slice(sep + 2));
    }
    return { summaries: [...summaries], questionIds: [...questionIds] };
  }

  async gapPairsForIds(gapIds: string[]): Promise<Array<{ questionId: string; summary: string }>> {
    const pairs: Array<{ questionId: string; summary: string }> = [];
    for (const id of gapIds) {
      const sep = id.indexOf("::");
      if (sep === -1) {
        continue;
      }
      pairs.push({ questionId: id.slice(0, sep), summary: id.slice(sep + 2) });
    }
    return pairs;
  }

  async listUnresolvedGapIds(gapIds: string[]): Promise<string[]> {
    const unresolved: string[] = [];
    for (const id of gapIds) {
      const sep = id.indexOf("::");
      if (sep === -1) {
        continue;
      }
      const logId = id.slice(0, sep);
      const summary = id.slice(sep + 2);
      const gap = this.logs.get(logId)?.gaps?.find((candidate) => candidate.summary === summary);
      if (gap && !gap.resolvedAt && !gap.dismissedAt) {
        unresolved.push(id);
      }
    }
    return unresolved;
  }

  async record(input: QuestionLogInput): Promise<QuestionLog> {
    const log: QuestionLog = {
      id: randomUUID(),
      question: input.question,
      chatProvider: input.chatProvider,
      confidence: input.answer?.confidence ?? "unknown",
      retrievedSectionIds: input.retrievedSectionIds,
      answer: input.answer,
      gaps: gapsFromAnswer(input.answer),
      // Match the Postgres column default (manual_gap boolean NOT NULL DEFAULT false).
      manualGap: false,
      askedAt: new Date().toISOString(),
      purpose: input.purpose ?? "live",
      ...(input.flowId ? { flowId: input.flowId } : {})
    };

    this.logs.set(log.id, log);
    if (log.gaps && log.gaps.length > 0) {
      this.bumpCatalog(log.flowId);
    }
    return log;
  }

  async get(id: string): Promise<QuestionLog | undefined> {
    return this.logs.get(id);
  }

  async updateAnswer(id: string, input: QuestionLogUpdateInput): Promise<QuestionLog | undefined> {
    const existing = this.logs.get(id);
    if (!existing) {
      return undefined;
    }

    // The flow is decided by the watcher after the log is recorded, so a
    // completion can supply it now; fall back to any flow already on the log.
    const flowId = input.flowId ?? existing.flowId;
    // A verification re-ask log (#154) keeps its answer + citations for audit, but
    // its gap signals are the merged doc's shortfall, not a fresh gap — never
    // ingest them, or they re-enter candidacy under this synthetic id and
    // auto-redraft the parked gap.
    const isVerification = existing.purpose === "verification";
    const nextAnswerGaps = isVerification ? [] : gapsFromAnswer(input.answer);
    const updated: QuestionLog = {
      ...existing,
      chatProvider: input.chatProvider ?? existing.chatProvider,
      confidence: input.answer.confidence,
      retrievedSectionIds: input.answer.citations.map((citation) => citation.sectionId),
      answer: input.answer,
      // Re-answering replaces auto-detected and followup gaps but preserves any
      // manual flag. A verification log ingests no gaps, so its existing gaps
      // (there are none) are left as-is.
      gaps: isVerification
        ? (existing.gaps ?? [])
        : [...(existing.gaps ?? []).filter((gap) => gap.source === "manual"), ...nextAnswerGaps],
      ...(flowId ? { flowId } : {})
    };

    this.logs.set(id, updated);
    // Re-answering replaces the auto-detected gaps, changing the candidate set —
    // but only bump when it ACTUALLY changed. An identical re-answer (same gaps,
    // same flow) leaves the candidate set untouched, so bumping would only make the
    // reconciler re-run its metered reshape on an unchanged cluster set (#168).
    const gapsChanged = !isVerification && !answerGapsUnchanged(existing.gaps ?? [], nextAnswerGaps);
    const flowChanged = (existing.flowId ?? "") !== (flowId ?? "");
    if (gapsChanged || flowChanged) {
      this.bumpCatalog(flowId);
    }
    return updated;
  }

  async recordFeedback(id: string, feedback: QuestionFeedback): Promise<QuestionLog | undefined> {
    const existing = this.logs.get(id);
    if (!existing) {
      return undefined;
    }

    const updated: QuestionLog = {
      ...existing,
      feedback,
      feedbackAt: new Date().toISOString()
    };

    this.logs.set(id, updated);
    return updated;
  }

  async recordManualGap(id: string, summary?: string): Promise<QuestionLog | undefined> {
    const existing = this.logs.get(id);
    if (!existing) {
      return undefined;
    }

    const trimmed = summary?.trim();
    const manualGap: QuestionGap = { summary: trimmed || existing.question, source: "manual" };
    const updated: QuestionLog = {
      ...existing,
      manualGap: true,
      manualGapAt: new Date().toISOString(),
      // Replace any prior manual gap; auto-detected gaps are left untouched.
      gaps: [...(existing.gaps ?? []).filter((gap) => gap.source !== "manual"), manualGap]
    };

    this.logs.set(id, updated);
    this.bumpCatalog(existing.flowId);
    return updated;
  }

  async clearManualGap(id: string): Promise<QuestionLog | undefined> {
    const existing = this.logs.get(id);
    if (!existing) {
      return undefined;
    }

    const updated: QuestionLog = {
      ...existing,
      manualGap: false,
      manualGapAt: undefined,
      // Drop the manual flag's gap; any auto-detected gaps remain candidates.
      gaps: (existing.gaps ?? []).filter((gap) => gap.source !== "manual")
    };

    this.logs.set(id, updated);
    if (existing.manualGap) {
      this.bumpCatalog(existing.flowId);
    }
    return updated;
  }

  async recordVerificationGap(
    id: string,
    gap: { summary: string; note: string; parked: boolean }
  ): Promise<QuestionLog | undefined> {
    const existing = this.logs.get(id);
    if (!existing) {
      return undefined;
    }

    const gaps = existing.gaps ?? [];
    const liveIndex = gaps.findIndex((g) => g.source === "verification" && !g.resolvedAt && !g.dismissedAt);

    // When `parked` (retry cap hit) stamp parkedAt; otherwise preserve any parked
    // state already on the live row (mirrors the Postgres CASE-preserving update).
    const prior = liveIndex === -1 ? undefined : gaps[liveIndex];
    const parkedAt = gap.parked ? new Date().toISOString() : prior?.parkedAt;
    const parkedReason = gap.parked ? "verification retry cap" : prior?.parkedReason;
    const verificationGap: QuestionGap = {
      summary: gap.summary,
      source: "verification",
      note: gap.note,
      ...(parkedAt ? { parkedAt, ...(parkedReason ? { parkedReason } : {}) } : {})
    };
    // Update the live 'verification' gap in place (if one exists) with the latest
    // reopen note; auto/manual/followup gaps are left untouched. Resolved and
    // dismissed rows are never touched: they stay retained for audit and are never
    // resurrected. Only when no live gap exists (none has ever been raised, or the
    // prior one was resolved/dismissed) is a fresh gap appended alongside history.
    const updatedGaps =
      liveIndex === -1
        ? [...gaps, verificationGap]
        : gaps.map((g, index) => (index === liveIndex ? verificationGap : g));

    const updated: QuestionLog = { ...existing, gaps: updatedGaps };

    this.logs.set(id, updated);
    this.bumpCatalog(existing.flowId);
    return updated;
  }

  async retryParkedGap(id: string): Promise<QuestionLog | undefined> {
    const existing = this.logs.get(id);
    if (!existing) {
      return undefined;
    }
    const gaps = existing.gaps ?? [];
    const parkedIndex = gaps.findIndex((gap) => gap.parkedAt && !gap.resolvedAt && !gap.dismissedAt);
    if (parkedIndex === -1) {
      // Not parked (or already retried) — no-op, race-safe.
      return existing;
    }
    const parked = gaps[parkedIndex]!;
    const dismissedAt = new Date().toISOString();
    // Dismiss the parked row (ends the lineage → fresh retry budget).
    const nextGaps = gaps.map((gap, index) =>
      index === parkedIndex ? { ...gap, dismissedAt, dismissedReason: "human_retry" } : gap
    );
    // Re-file a fresh LIVE 'verification' row carrying the note, so the redraft
    // still sees why the last merge fell short (draftFromGaps reads resubmission
    // notes only off live verification gaps). The dismissed parked row's note would
    // otherwise be lost even though its sibling auto gap re-drafts (C1). File it
    // under the surviving live gap's summary when exactly one remains — the common
    // case, and the summary-fallback case — so it dedups with that gap into a
    // single candidate instead of forking a duplicate (#158 review #4). Skip the
    // re-file only when there is no note to preserve AND a live gap already remains.
    const survivingLive = nextGaps.filter((gap) => !gap.resolvedAt && !gap.dismissedAt);
    if (parked.note || survivingLive.length === 0) {
      const targetSummary = survivingLive.length === 1 ? survivingLive[0]!.summary : parked.summary;
      nextGaps.push({
        summary: targetSummary,
        source: "verification",
        ...(parked.note ? { note: parked.note } : {})
      });
    }
    const updated: QuestionLog = { ...existing, gaps: nextGaps };
    this.logs.set(id, updated);
    this.bumpCatalog(existing.flowId);
    return updated;
  }

  async dismissParkedGap(id: string): Promise<QuestionLog | undefined> {
    const existing = this.logs.get(id);
    if (!existing) {
      return undefined;
    }
    const gaps = existing.gaps ?? [];
    const parked = gaps.find((gap) => gap.parkedAt && !gap.resolvedAt && !gap.dismissedAt);
    if (!parked) {
      // Not parked — no-op, race-safe.
      return existing;
    }
    const dismissedAt = new Date().toISOString();
    // Abandon the PARKED topic: dismiss the live gaps sharing the parked summary
    // (the verification row + its sibling auto gap). Unrelated topics on a
    // multi-topic question — only hidden by question-level parking, never escalated
    // — survive and re-enter candidacy (#158 review #2).
    const nextGaps = gaps.map((gap) =>
      !gap.resolvedAt && !gap.dismissedAt && gap.summary === parked.summary
        ? { ...gap, dismissedAt, dismissedReason: "human_dismiss" }
        : gap
    );
    const updated: QuestionLog = { ...existing, gaps: nextGaps };
    this.logs.set(id, updated);
    this.bumpCatalog(existing.flowId);
    return updated;
  }

  async listParkedQuestions(limit: number): Promise<ParkedQuestion[]> {
    const parked: ParkedQuestion[] = [];
    for (const log of this.logs.values()) {
      const gap = (log.gaps ?? []).find((g) => g.parkedAt && !g.resolvedAt && !g.dismissedAt);
      if (!gap?.parkedAt) {
        continue;
      }
      parked.push({
        questionId: log.id,
        question: log.question,
        summary: gap.summary,
        parkedAt: gap.parkedAt,
        ...(log.flowId ? { flowId: log.flowId } : {}),
        ...(gap.note ? { note: gap.note } : {})
      });
    }
    return parked.sort((a, b) => b.parkedAt.localeCompare(a.parkedAt)).slice(0, limit);
  }

  async resolveGaps(questionIds: string[], summaries: string[], proposalId: string): Promise<number> {
    const questionSet = new Set(questionIds);
    const summarySet = new Set(summaries.map((summary) => summary.trim()).filter((summary) => summary.length > 0));
    if (questionSet.size === 0 || summarySet.size === 0) {
      return 0;
    }

    const resolvedAt = new Date().toISOString();
    let resolved = 0;
    // Bump every flow that actually had a gap resolved (a proposal's questions
    // share a flow in practice, but resolving spans whatever the caller passes).
    const resolvedFlows = new Set<string>();
    for (const log of this.logs.values()) {
      if (!questionSet.has(log.id) || !log.gaps?.length) {
        continue;
      }

      let resolvedHere = 0;
      const gaps = log.gaps.map((gap) => {
        // A dismissed gap is intentionally settled — a proposal merge must never
        // flip it back to resolved (mirrors the Postgres store's dismissed_at guard).
        if (gap.resolvedAt || gap.dismissedAt || !summarySet.has(gap.summary)) {
          return gap;
        }
        resolved += 1;
        resolvedHere += 1;
        return { ...gap, resolvedAt, resolvedByProposalId: proposalId };
      });
      this.logs.set(log.id, { ...log, gaps });
      if (resolvedHere > 0) {
        resolvedFlows.add(log.flowId ?? "");
      }
    }

    for (const flow of resolvedFlows) {
      this.bumpCatalog(flow);
    }
    return resolved;
  }

  async dismissGaps(gapIds: string[], reason: string): Promise<number> {
    const dismissedAt = new Date().toISOString();
    const trimmedReason = reason.trim();
    let dismissed = 0;
    const dismissedFlows = new Set<string>();
    for (const id of gapIds) {
      const sep = id.indexOf("::");
      if (sep === -1) {
        continue;
      }
      const logId = id.slice(0, sep);
      const summary = id.slice(sep + 2);
      const log = this.logs.get(logId);
      if (!log?.gaps) {
        continue;
      }
      let dismissedHere = 0;
      const gaps = log.gaps.map((gap) => {
        // In-memory gap ids are `${logId}::${summary}`, so a parked row and its
        // sibling auto row share an id — never let a reconciler-reachable dismissal
        // discharge a parked escalation; a human settles those via dismissParkedGap
        // (#158). (The Postgres store guards the same with `AND parked_at IS NULL`.)
        if (gap.summary !== summary || gap.resolvedAt || gap.dismissedAt || gap.parkedAt) {
          return gap;
        }
        dismissed += 1;
        dismissedHere += 1;
        return { ...gap, dismissedAt, ...(trimmedReason ? { dismissedReason: trimmedReason } : {}) };
      });
      if (dismissedHere > 0) {
        this.logs.set(logId, { ...log, gaps });
        dismissedFlows.add(log.flowId ?? "");
      }
    }

    for (const flow of dismissedFlows) {
      this.bumpCatalog(flow);
    }
    return dismissed;
  }

  async list(limit: number): Promise<QuestionLog[]> {
    // Only live questions surface in the console list; verification re-asks (#154)
    // are synthetic audit records, not questions a human asked.
    return [...this.logs.values()]
      .filter((log) => log.purpose !== "verification")
      .sort((left, right) => right.askedAt.localeCompare(left.askedAt))
      .slice(0, limit);
  }

  async reset(): Promise<void> {
    this.logs.clear();
    this.gapCatalogRevision.clear();
  }

  async listGapCandidates(limit: number): Promise<GapCandidate[]> {
    // Group by (flowId, summary) so the same gap surfaced under two flows yields
    // two candidates — each clusters and drafts within its own flow. The flowId
    // is folded into the key, space-separated (flow IDs are slugs with no spaces,
    // so the key can't be ambiguous).
    // Candidacy keys on unresolved gap rows, not question confidence: gap rows
    // are only written when something was verifiably missing, and a 'followup'
    // gap on a confident answer (an observed empty search) must still cluster.
    const groups = new Map<string, { summary: string; flowId?: string; logs: QuestionLog[] }>();
    for (const log of this.logs.values()) {
      // Verification re-ask logs (#154) are synthetic and never candidates.
      if (log.purpose === "verification") {
        continue;
      }
      const active = (log.gaps ?? []).filter((gap) => !gap.resolvedAt && !gap.dismissedAt);
      // A question with a live PARKED gap hit the verification retry cap: it
      // awaits a human, so park the WHOLE question (including its sibling
      // auto/manual gap) out of the candidate set. Gaps on OTHER questions
      // sharing the summary are unaffected.
      if (active.some((gap) => gap.parkedAt)) {
        continue;
      }
      const summaries = new Set(active.map((gap) => gap.summary));
      for (const summary of summaries) {
        const key = `${log.flowId ?? ""} ${summary}`;
        const group = groups.get(key) ?? { summary, flowId: log.flowId, logs: [] };
        group.logs.push(log);
        groups.set(key, group);
      }
    }

    return [...groups.values()]
      .map(({ summary, flowId, logs }) => ({
        summary,
        questionIds: logs.map((log) => log.id),
        count: logs.length,
        latestAskedAt:
          logs
            .map((log) => log.askedAt)
            .sort()
            .at(-1) ?? new Date(0).toISOString(),
        confidence: "low" as const,
        ...(flowId ? { flowId } : {})
      }))
      .sort((left, right) => right.count - left.count || right.latestAskedAt.localeCompare(left.latestAskedAt))
      .slice(0, limit);
  }
}
