import { randomUUID } from "node:crypto";
import pg from "pg";
import type {
  AnswerResult,
  Citation,
  Confidence,
  GapCandidate,
  ParkedQuestion,
  QuestionFeedback,
  QuestionGap,
  QuestionGapSource,
  QuestionLog,
  QuestionLogInput,
  QuestionLogUpdateInput
} from "@magpie/core";
import { answerGapsUnchanged, gapSummaryKey, isSeedableGapSummary, type QuestionLogStore } from "./question-log-store.js";
import { valuesClause } from "./sql-bulk.js";

export class PostgresQuestionLogStore implements QuestionLogStore {
  constructor(private readonly pool: pg.Pool) {}

  async getGapCatalogRevision(flowId?: string): Promise<number> {
    const result = await this.pool.query<{ revision: string }>("SELECT revision FROM gap_catalog WHERE flow_id = $1", [
      flowId ?? ""
    ]);
    return result.rows[0] ? Number(result.rows[0].revision) : 0;
  }

  async gapIdsForSummary(summary: string, flowId?: string): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      `
        SELECT qg.id::text AS id
        FROM question_gaps qg
        JOIN questions q ON q.id = qg.question_id
        WHERE qg.resolved_at IS NULL
          AND qg.dismissed_at IS NULL
          -- Gap-candidate purposes: live asks and questionnaire item asks (an
          -- unanswerable questionnaire question is a real gap). Verification
          -- re-asks stay excluded (#154).
          AND q.purpose IN ('live', 'questionnaire')
          -- Exclude EVERY gap of a parked question (question-level, matching
          -- candidacy) so a parked escalation — or its sibling auto row — can
          -- never be swept into a cluster where an AI dismissal discharges it (#158).
          AND qg.question_id NOT IN (
            SELECT question_id FROM question_gaps
            WHERE parked_at IS NOT NULL AND resolved_at IS NULL AND dismissed_at IS NULL
          )
          AND qg.summary = $1
          AND coalesce(q.flow_id, '') = coalesce($2, '')
        ORDER BY qg.id ASC
      `,
      [summary, flowId ?? null]
    );
    return result.rows.map((row) => row.id);
  }

  async gapIdsForSummaries(pairs: Array<{ summary: string; flowId?: string }>): Promise<Map<string, string[]>> {
    // Pre-seed every requested pair so the caller gets an entry (possibly empty)
    // for each, matching the in-memory store. Dedupe so a repeated pair binds once.
    const result = new Map<string, string[]>();
    const unique = new Map<string, { summary: string; flow: string }>();
    for (const { summary, flowId } of pairs) {
      const flow = flowId ?? "";
      const key = gapSummaryKey(summary, flowId);
      result.set(key, []);
      unique.set(key, { summary, flow });
    }
    if (unique.size === 0) {
      return result;
    }

    // One query resolves every (summary, flow) pair at once: a VALUES list of the
    // requested pairs is joined to question_gaps, and each row comes back tagged
    // with its summary+flow so its id routes to the right bucket. ORDER BY qg.id
    // ASC keeps the same ordering gapIdsForSummary returns within a pair.
    const summaries: string[] = [];
    const flows: string[] = [];
    for (const { summary, flow } of unique.values()) {
      summaries.push(summary);
      flows.push(flow);
    }
    const rows = await this.pool.query<{ summary: string; flow: string; id: string }>(
      `
        WITH pairs AS (
          SELECT * FROM unnest($1::text[], $2::text[]) AS p(summary, flow)
        )
        SELECT p.summary AS summary, p.flow AS flow, qg.id::text AS id
        FROM pairs p
        JOIN question_gaps qg ON qg.summary = p.summary AND qg.resolved_at IS NULL AND qg.dismissed_at IS NULL
        JOIN questions q ON q.id = qg.question_id AND coalesce(q.flow_id, '') = p.flow
          AND q.purpose IN ('live', 'questionnaire')
        -- Exclude every gap of a parked question, matching gapIdsForSummary/candidacy (#158).
        WHERE qg.question_id NOT IN (
          SELECT question_id FROM question_gaps
          WHERE parked_at IS NOT NULL AND resolved_at IS NULL AND dismissed_at IS NULL
        )
        ORDER BY qg.id ASC
      `,
      [summaries, flows]
    );

    for (const row of rows.rows) {
      const bucket = result.get(gapSummaryKey(row.summary, row.flow));
      if (bucket) {
        bucket.push(row.id);
      }
    }
    return result;
  }

  async gapDetailsForIds(gapIds: string[]): Promise<{ summaries: string[]; questionIds: string[] }> {
    if (gapIds.length === 0) {
      return { summaries: [], questionIds: [] };
    }
    const result = await this.pool.query<{ summary: string; question_id: string }>(
      "SELECT summary, question_id FROM question_gaps WHERE id = ANY($1::bigint[])",
      [gapIds]
    );
    const summaries = new Set<string>();
    const questionIds = new Set<string>();
    for (const row of result.rows) {
      summaries.add(row.summary);
      questionIds.add(row.question_id);
    }
    return { summaries: [...summaries], questionIds: [...questionIds] };
  }

  async gapPairsForIds(gapIds: string[]): Promise<Array<{ questionId: string; summary: string }>> {
    if (gapIds.length === 0) {
      return [];
    }
    const result = await this.pool.query<{ summary: string; question_id: string }>(
      "SELECT summary, question_id FROM question_gaps WHERE id = ANY($1::bigint[])",
      [gapIds]
    );
    return result.rows.map((row) => ({ questionId: row.question_id, summary: row.summary }));
  }

  async listUnresolvedGapIds(gapIds: string[]): Promise<string[]> {
    if (gapIds.length === 0) {
      return [];
    }
    const result = await this.pool.query<{ id: string }>(
      "SELECT id::text AS id FROM question_gaps WHERE id = ANY($1::bigint[]) AND resolved_at IS NULL AND dismissed_at IS NULL",
      [gapIds]
    );
    return result.rows.map((row) => row.id);
  }

  async record(input: QuestionLogInput): Promise<QuestionLog> {
    const id = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          INSERT INTO questions (
            id, question, confidence, answer, chat_provider, flow_id, metadata, purpose
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          id,
          input.question,
          input.answer?.confidence ?? "unknown",
          input.answer?.answer ?? null,
          input.chatProvider,
          input.flowId ?? null,
          JSON.stringify({
            answer: input.answer ?? null,
            retrievedSectionIds: input.retrievedSectionIds
          }),
          input.purpose ?? "live"
        ]
      );

      const gapRows = answerGapRows(input.answer);
      await insertGapRows(client, id, gapRows);
      if (gapRows.length > 0) {
        await bumpGapCatalog(client, input.flowId ?? null);
      }

      await insertCitationRows(client, id, input.answer?.citations ?? [], { onConflictUpdate: true });

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const log = await this.get(id);
    if (!log) {
      throw new Error(`Question log not found after insert: ${id}`);
    }

    return log;
  }

  async get(id: string): Promise<QuestionLog | undefined> {
    const result = await this.pool.query<QuestionRow>("SELECT * FROM questions WHERE id = $1", [id]);
    if (!result.rows[0]) {
      return undefined;
    }

    const gapsByQuestion = await this.loadGaps([id]);
    return mapQuestionRow(result.rows[0], gapsByQuestion.get(id) ?? []);
  }

  async delete(id: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{ flow_id: string | null }>("SELECT flow_id FROM questions WHERE id = $1", [
        id
      ]);
      if (existing.rowCount !== 1) {
        await client.query("ROLLBACK");
        return false;
      }
      const hadGaps = await client.query("SELECT 1 FROM question_gaps WHERE question_id = $1 LIMIT 1", [id]);
      // ON DELETE CASCADE removes answer_citations, question_gaps, and (via the
      // gap FK) gap_cluster_memberships.
      await client.query("DELETE FROM questions WHERE id = $1", [id]);
      if ((hadGaps.rowCount ?? 0) > 0) {
        await bumpGapCatalog(client, existing.rows[0].flow_id);
      }
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async gapIdsForQuestion(id: string): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      "SELECT id::text AS id FROM question_gaps WHERE question_id = $1 ORDER BY id ASC",
      [id]
    );
    return result.rows.map((row) => row.id);
  }

  async updateAnswer(id: string, input: QuestionLogUpdateInput): Promise<QuestionLog | undefined> {
    const existing = await this.get(id);
    if (!existing) {
      return undefined;
    }

    const metadata = {
      answer: input.answer,
      retrievedSectionIds: input.answer.citations.map((citation) => citation.sectionId)
    };
    // The flow is decided by the watcher after the log is recorded, so a
    // completion can supply it now; fall back to any flow already on the row.
    const flowId = input.flowId ?? existing.flowId ?? null;
    const nextGapRows = answerGapRows(input.answer);
    // Only the answer-derived gaps changing (or the gaps moving to another flow)
    // actually changes the candidate set. An identical re-answer would otherwise
    // delete+reinsert byte-identical rows — minting new gap ids that orphan cluster
    // memberships (ON DELETE CASCADE) — and bump the revision, forcing the
    // reconciler to re-run its metered reshape on an unchanged cluster set (#168).
    // When nothing changed, leave the gap rows (and their memberships) untouched.
    // A verification re-ask log (#154) records its answer + citations for audit,
    // but its gap signals are the merged doc's shortfall, not a fresh gap — never
    // ingest them, or they re-enter candidacy under this synthetic question id and
    // auto-redraft the parked gap.
    const gapsChanged = !answerGapsUnchanged(existing.gaps ?? [], nextGapRows);
    const flowChanged = (existing.flowId ?? "") !== (flowId ?? "");
    const replaceGaps = existing.purpose !== "verification" && (gapsChanged || flowChanged);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          UPDATE questions
          SET confidence = $2,
              answer = $3,
              chat_provider = $4,
              metadata = $5,
              flow_id = $6
          WHERE id = $1
        `,
        [
          id,
          input.answer.confidence,
          input.answer.answer,
          input.chatProvider ?? existing.chatProvider,
          JSON.stringify(metadata),
          flowId
        ]
      );
      if (replaceGaps) {
        // Re-answering replaces the answer-derived gaps (auto + followup) but
        // preserves any manual flag.
        await client.query("DELETE FROM question_gaps WHERE question_id = $1 AND source IN ('auto', 'followup')", [id]);
        await insertGapRows(client, id, nextGapRows);
        // The candidate set changed, so advance the revision for the reconciler.
        await bumpGapCatalog(client, flowId);
      }
      await client.query("DELETE FROM answer_citations WHERE question_id = $1", [id]);

      await insertCitationRows(client, id, input.answer.citations, { onConflictUpdate: false });

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return this.get(id);
  }

  async recordFeedback(id: string, feedback: QuestionFeedback): Promise<QuestionLog | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{
        question: string;
        confidence: Confidence;
        flow_id: string | null;
        purpose: string;
      }>(
        `
          UPDATE questions
          SET feedback = $2,
              feedback_at = now()
          WHERE id = $1
          RETURNING question, confidence, flow_id, purpose
        `,
        [id, feedback]
      );

      if (result.rowCount !== 1) {
        await client.query("ROLLBACK");
        return undefined;
      }

      // 'unhelpful' on a CONFIDENT (high/medium) live answer is a strong quality
      // signal — the user rejected an answer the system believed in — so it
      // enters gap candidacy as a server-side 'feedback' gap (#241), the way
      // followup misses do. The summary falls back to the question text (like
      // the manual flag). Low/unknown answers are excluded: they already raised
      // their own 'auto' gaps (or were deliberately gap-less, e.g. out-of-scope).
      // Repeated 'unhelpful' keeps the existing live row — and its gap id, so any
      // cluster membership survives — rather than minting a duplicate. Flipping
      // to 'helpful' withdraws the signal: live feedback rows are deleted
      // (matching the manual-flag clear), while resolved/dismissed rows stay
      // retained for audit.
      const row = result.rows[0]!;
      const confident = row.confidence === "high" || row.confidence === "medium";
      let candidatesChanged = 0;
      if (feedback === "unhelpful") {
        if (row.purpose === "live" && confident) {
          const inserted = await client.query(
            `
              INSERT INTO question_gaps (question_id, summary, source)
              SELECT $1, $2, 'feedback'
              WHERE NOT EXISTS (
                SELECT 1 FROM question_gaps
                WHERE question_id = $1 AND source = 'feedback'
                  AND resolved_at IS NULL AND dismissed_at IS NULL
              )
            `,
            [id, row.question]
          );
          candidatesChanged = inserted.rowCount ?? 0;
        }
      } else {
        const deleted = await client.query(
          `
            DELETE FROM question_gaps
            WHERE question_id = $1 AND source = 'feedback'
              AND resolved_at IS NULL AND dismissed_at IS NULL
          `,
          [id]
        );
        candidatesChanged = deleted.rowCount ?? 0;
      }
      if (candidatesChanged > 0) {
        await bumpGapCatalog(client, row.flow_id);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return this.get(id);
  }

  async recordManualGap(id: string, summary?: string): Promise<QuestionLog | undefined> {
    const trimmed = summary?.trim();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `
          UPDATE questions
          SET manual_gap = true,
              manual_gap_at = now()
          WHERE id = $1
          RETURNING question, flow_id
        `,
        [id]
      );

      if (result.rowCount !== 1) {
        await client.query("ROLLBACK");
        return undefined;
      }

      // Replace any prior manual gap; auto-detected gaps are left untouched. The
      // summary falls back to the question text when none is supplied.
      const row = result.rows[0] as { question: string; flow_id: string | null };
      const manualSummary = trimmed && trimmed.length > 0 ? trimmed : row.question;
      await client.query("DELETE FROM question_gaps WHERE question_id = $1 AND source = 'manual'", [id]);
      await insertGapRows(client, id, [{ summary: manualSummary, source: "manual" }]);
      await bumpGapCatalog(client, row.flow_id);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return this.get(id);
  }

  async recordVerificationGap(
    id: string,
    gap: { summary: string; note: string; parked: boolean }
  ): Promise<QuestionLog | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ flow_id: string | null }>("SELECT flow_id FROM questions WHERE id = $1", [
        id
      ]);

      if (result.rowCount !== 1) {
        await client.query("ROLLBACK");
        return undefined;
      }

      // Update the live 'verification' row in place (if one exists) with the
      // latest reopen note, so its gap id — and any cluster membership keyed off
      // that id — survives. When `parked` (the retry cap was hit) the row is also
      // stamped parked_at, escalating the whole question to "awaiting a human"
      // WITHOUT changing its source. auto, manual and followup gaps are left
      // untouched. Resolved and dismissed rows are never touched here: they stay
      // retained for audit and are never resurrected. Only when no live row
      // exists (no verification gap yet, or the prior one was resolved/dismissed)
      // is a fresh row inserted alongside that retained history.
      const updatedRow = await client.query(
        `
          UPDATE question_gaps
          SET summary = $2, source = 'verification', note = $3,
              parked_at = CASE WHEN $4 THEN now() ELSE parked_at END,
              parked_reason = CASE WHEN $4 THEN 'verification retry cap' ELSE parked_reason END
          WHERE question_id = $1
            AND source = 'verification'
            AND resolved_at IS NULL
            AND dismissed_at IS NULL
        `,
        [id, gap.summary, gap.note, gap.parked]
      );
      if ((updatedRow.rowCount ?? 0) === 0) {
        await client.query(
          `
            INSERT INTO question_gaps (question_id, summary, source, note, parked_at, parked_reason)
            VALUES ($1, $2, 'verification', $3,
                    CASE WHEN $4 THEN now() END,
                    CASE WHEN $4 THEN 'verification retry cap' END)
          `,
          [id, gap.summary, gap.note, gap.parked]
        );
      }
      await bumpGapCatalog(client, result.rows[0].flow_id);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return this.get(id);
  }

  async retryParkedGap(id: string): Promise<QuestionLog | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Dismiss the live parked row (ends the failed lineage → fresh retry budget),
      // returning its summary + note so we can re-file if nothing live remains.
      const dismissed = await client.query<{ summary: string; note: string | null; flow_id: string | null }>(
        `
          UPDATE question_gaps qg
          SET dismissed_at = now(), dismissed_reason = 'human_retry'
          FROM questions q
          WHERE qg.question_id = q.id
            AND qg.question_id = $1
            AND qg.parked_at IS NOT NULL
            AND qg.resolved_at IS NULL
            AND qg.dismissed_at IS NULL
          RETURNING qg.summary AS summary, qg.note AS note, q.flow_id AS flow_id
        `,
        [id]
      );
      if ((dismissed.rowCount ?? 0) === 0) {
        // Not parked (or already retried) — no-op, race-safe.
        await client.query("ROLLBACK");
        return this.get(id);
      }
      const { summary, note, flow_id } = dismissed.rows[0]!;
      // Re-file a fresh LIVE 'verification' row carrying the note, so the redraft
      // still sees why the last merge fell short (draftFromGaps reads resubmission
      // notes only off live verification gaps). The dismissed parked row's note
      // would otherwise be lost even though its sibling auto gap re-drafts (C1).
      // File it under the surviving live gap's summary when exactly one remains —
      // the common case, and the summary-fallback case — so it dedups with that gap
      // into a single candidate rather than forking a duplicate (#158 review #4).
      // Skip only when there is no note to preserve AND a live gap already remains.
      const survivors = await client.query<{ summary: string }>(
        `
          SELECT summary FROM question_gaps
          WHERE question_id = $1 AND resolved_at IS NULL AND dismissed_at IS NULL
        `,
        [id]
      );
      const survivingSummaries = survivors.rows.map((row) => row.summary);
      if (note !== null || survivingSummaries.length === 0) {
        const targetSummary = survivingSummaries.length === 1 ? survivingSummaries[0]! : summary;
        await client.query(
          `
            INSERT INTO question_gaps (question_id, summary, source, note)
            VALUES ($1, $2, 'verification', $3)
          `,
          [id, targetSummary, note]
        );
      }
      await bumpGapCatalog(client, flow_id);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return this.get(id);
  }

  async dismissParkedGap(id: string): Promise<QuestionLog | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Only act when the question is actually parked; then abandon the PARKED
      // TOPIC by dismissing the live gaps sharing the parked summary. Unrelated
      // topics on a multi-topic question — only hidden by question-level parking,
      // never escalated — survive and re-enter candidacy (#158 review #2).
      const parked = await client.query<{ summary: string }>(
        `
          SELECT summary FROM question_gaps
          WHERE question_id = $1 AND parked_at IS NOT NULL
            AND resolved_at IS NULL AND dismissed_at IS NULL
          LIMIT 1
        `,
        [id]
      );
      if ((parked.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return this.get(id);
      }
      const parkedSummary = parked.rows[0]!.summary;
      const dismissed = await client.query<{ flow_id: string | null }>(
        `
          UPDATE question_gaps qg
          SET dismissed_at = now(), dismissed_reason = 'human_dismiss'
          FROM questions q
          WHERE qg.question_id = q.id
            AND qg.question_id = $1
            AND qg.summary = $2
            AND qg.resolved_at IS NULL
            AND qg.dismissed_at IS NULL
          RETURNING q.flow_id AS flow_id
        `,
        [id, parkedSummary]
      );
      if ((dismissed.rowCount ?? 0) > 0) {
        await bumpGapCatalog(client, dismissed.rows[0]!.flow_id);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return this.get(id);
  }

  async listParkedQuestions(limit: number): Promise<ParkedQuestion[]> {
    const result = await this.pool.query<{
      question_id: string;
      question: string;
      flow_id: string | null;
      summary: string;
      note: string | null;
      parked_at: Date;
    }>(
      `
        SELECT q.id AS question_id, q.question, q.flow_id, qg.summary, qg.note, qg.parked_at
        FROM question_gaps qg
        JOIN questions q ON q.id = qg.question_id
        WHERE qg.parked_at IS NOT NULL AND qg.resolved_at IS NULL AND qg.dismissed_at IS NULL
        ORDER BY qg.parked_at DESC
        LIMIT $1
      `,
      [limit]
    );
    return result.rows.map((row) => ({
      questionId: row.question_id,
      question: row.question,
      summary: row.summary,
      parkedAt: row.parked_at.toISOString(),
      ...(row.flow_id ? { flowId: row.flow_id } : {}),
      ...(row.note ? { note: row.note } : {})
    }));
  }

  async clearManualGap(id: string): Promise<QuestionLog | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ flow_id: string | null }>(
        `
          UPDATE questions
          SET manual_gap = false,
              manual_gap_at = null
          WHERE id = $1
          RETURNING flow_id
        `,
        [id]
      );

      if (result.rowCount !== 1) {
        await client.query("ROLLBACK");
        return undefined;
      }

      // Drop the manual flag's gap; any auto-detected gaps remain candidates.
      const deleted = await client.query("DELETE FROM question_gaps WHERE question_id = $1 AND source = 'manual'", [
        id
      ]);
      if ((deleted.rowCount ?? 0) > 0) {
        await bumpGapCatalog(client, result.rows[0].flow_id);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return this.get(id);
  }

  async list(limit: number, offset = 0, search?: string): Promise<QuestionLog[]> {
    // Only live questions surface in the console list; verification re-asks (#154)
    // are synthetic audit records, not questions a human asked.
    const result = await this.pool.query<QuestionRow>(
      `SELECT * FROM questions
       WHERE purpose = 'live' AND ($3::text IS NULL OR question ILIKE $3)
       ORDER BY asked_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset, searchPattern(search)]
    );
    const gapsByQuestion = await this.loadGaps(result.rows.map((row) => row.id));
    return result.rows.map((row) => mapQuestionRow(row, gapsByQuestion.get(row.id) ?? []));
  }

  async count(search?: string): Promise<number> {
    // Same filter as list(): the total the pager reports must match what a full
    // page walk would return.
    const result = await this.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM questions WHERE purpose = 'live' AND ($1::text IS NULL OR question ILIKE $1)",
      [searchPattern(search)]
    );
    return result.rows[0]?.count ?? 0;
  }

  // Loads gap rows for the given questions in one query, grouped by question id.
  private async loadGaps(questionIds: string[]): Promise<Map<string, QuestionGap[]>> {
    const grouped = new Map<string, QuestionGap[]>();
    if (questionIds.length === 0) {
      return grouped;
    }

    const result = await this.pool.query<{
      question_id: string;
      summary: string;
      source: QuestionGapSource;
      note: string | null;
      resolved_at: Date | null;
      resolved_by_proposal_id: string | null;
      dismissed_at: Date | null;
      dismissed_reason: string | null;
      parked_at: Date | null;
      parked_reason: string | null;
    }>(
      `
        SELECT question_id, summary, source, note, resolved_at, resolved_by_proposal_id,
               dismissed_at, dismissed_reason, parked_at, parked_reason
        FROM question_gaps
        WHERE question_id = ANY($1)
        ORDER BY created_at ASC, id ASC
      `,
      [questionIds]
    );

    for (const row of result.rows) {
      const existing = grouped.get(row.question_id) ?? [];
      existing.push({
        summary: row.summary,
        source: row.source,
        note: row.note ?? undefined,
        resolvedAt: row.resolved_at?.toISOString(),
        resolvedByProposalId: row.resolved_by_proposal_id ?? undefined,
        dismissedAt: row.dismissed_at?.toISOString(),
        dismissedReason: row.dismissed_reason ?? undefined,
        parkedAt: row.parked_at?.toISOString(),
        parkedReason: row.parked_reason ?? undefined
      });
      grouped.set(row.question_id, existing);
    }

    return grouped;
  }

  async resolveGaps(questionIds: string[], summaries: string[], proposalId: string): Promise<number> {
    const trimmedSummaries = [
      ...new Set(summaries.map((summary) => summary.trim()).filter((summary) => summary.length > 0))
    ];
    if (questionIds.length === 0 || trimmedSummaries.length === 0) {
      return 0;
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ question_id: string }>(
        `
          UPDATE question_gaps
          SET resolved_at = now(), resolved_by_proposal_id = $3
          WHERE question_id = ANY($1)
            AND summary = ANY($2)
            AND resolved_at IS NULL
            AND dismissed_at IS NULL
          RETURNING question_id
        `,
        [questionIds, trimmedSummaries, proposalId]
      );
      const resolved = result.rowCount ?? 0;
      // Resolving gaps removes them from the candidate set, so each affected
      // flow's catalog advances in the same transaction.
      if (resolved > 0) {
        const affectedQuestionIds = [...new Set(result.rows.map((r) => r.question_id))];
        const flows = await client.query<{ flow_id: string }>(
          "SELECT DISTINCT coalesce(flow_id, '') AS flow_id FROM questions WHERE id = ANY($1)",
          [affectedQuestionIds]
        );
        for (const { flow_id } of flows.rows) {
          await bumpGapCatalog(client, flow_id);
        }
      }
      await client.query("COMMIT");
      return resolved;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async dismissGaps(gapIds: string[], reason: string): Promise<number> {
    if (gapIds.length === 0) {
      return 0;
    }
    const trimmedReason = reason.trim();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ question_id: string }>(
        `
          UPDATE question_gaps
          SET dismissed_at = now(), dismissed_reason = $2
          WHERE id = ANY($1::bigint[])
            AND resolved_at IS NULL
            AND dismissed_at IS NULL
            -- Never let a reconciler-reachable dismissal discharge a parked
            -- escalation; a human settles those via dismissParkedGap (#158).
            AND parked_at IS NULL
          RETURNING question_id
        `,
        [gapIds, trimmedReason || null]
      );
      const dismissed = result.rowCount ?? 0;
      // Dismissing gaps removes them from the candidate set, so each affected
      // flow's catalog advances in the same transaction.
      if (dismissed > 0) {
        const affectedQuestionIds = [...new Set(result.rows.map((r) => r.question_id))];
        const flows = await client.query<{ flow_id: string }>(
          "SELECT DISTINCT coalesce(flow_id, '') AS flow_id FROM questions WHERE id = ANY($1)",
          [affectedQuestionIds]
        );
        for (const { flow_id } of flows.rows) {
          await bumpGapCatalog(client, flow_id);
        }
      }
      await client.query("COMMIT");
      return dismissed;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async reset(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM answer_citations");
      await client.query("DELETE FROM question_gaps");
      await client.query("DELETE FROM questions");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listGapCandidates(limit: number): Promise<GapCandidate[]> {
    // Cluster across individual gap rows so each distinct gap of a multi-topic
    // question can group with the same gap from other questions. A question with
    // both a 'manual' and an 'auto' row for the same summary is counted once.
    // Group by (summary, flow_id) so the same gap raised under two flows yields
    // two candidates, each clustering and drafting within its own flow. flow_id
    // is coalesced to '' so NULL (un-routed) gaps still group with each other.
    //
    // Every unresolved, undismissed gap row is a candidate — candidacy keys on
    // the gap rows, NOT on the question's confidence. Gap rows are only written
    // when something was verifiably missing ('auto' rows only when the model
    // declared a whole-question gap — which ships at low, or at medium for a
    // substantive partial answer; 'followup' rows only when a search observably
    // came back empty, 'manual' rows only when an admin flags), so a
    // question-level confidence filter adds nothing for those — and it wrongly
    // hid gaps raised alongside confident answers (e.g. "searched for SOC 2
    // docs, found none", or a medium partial answer's declared miss), which are
    // exactly the gaps that should cluster and draft.
    const result = await this.pool.query<GapCandidateRow>(
      `
        SELECT
          summary,
          flow_id,
          array_agg(question_id ORDER BY asked_at DESC) AS question_ids,
          count(*)::int AS count,
          max(asked_at) AS latest_asked_at
        FROM (
          SELECT DISTINCT qg.summary, coalesce(q.flow_id, '') AS flow_id, q.id AS question_id, q.asked_at
          FROM question_gaps qg
          JOIN questions q ON q.id = qg.question_id
          WHERE qg.resolved_at IS NULL AND qg.dismissed_at IS NULL
            -- Verification re-ask logs (#154) are synthetic; their gap signals are
            -- the merged doc's shortfall, never a fresh candidate. Questionnaire
            -- item asks ARE candidates — an unanswerable questionnaire question
            -- is a real gap (docs/questionnaires.md).
            AND q.purpose IN ('live', 'questionnaire')
            -- A question with a live PARKED gap hit the verification retry cap: it
            -- awaits a human, so park the WHOLE question (all its gap rows,
            -- including the sibling auto/manual gap) out of the candidate set so
            -- it does not auto-recluster/redraft. Gaps on OTHER questions sharing
            -- the summary are unaffected.
            AND qg.question_id NOT IN (
              SELECT question_id FROM question_gaps
              WHERE parked_at IS NOT NULL AND resolved_at IS NULL AND dismissed_at IS NULL
            )
        ) AS distinct_gaps
        GROUP BY summary, flow_id
        ORDER BY count DESC, latest_asked_at DESC
        LIMIT $1
      `,
      [limit]
    );

    return result.rows.map((row) => ({
      summary: row.summary,
      questionIds: row.question_ids,
      count: row.count,
      latestAskedAt: row.latest_asked_at.toISOString(),
      confidence: "low",
      ...(row.flow_id ? { flowId: row.flow_id } : {})
    }));
  }
}

// Inserts one gap row per gap in a single multi-row INSERT (instead of one
// round-trip per gap). Each gap carries its own source, so a single answer can
// write both whole-question ("auto") and supporting-material ("followup") gaps,
// and the manual-flag path inserts a "manual" gap.
async function insertGapRows(
  client: pg.PoolClient,
  questionId: string,
  gaps: Array<{ summary: string; source: QuestionGapSource; note?: string }>
): Promise<void> {
  if (gaps.length === 0) {
    return;
  }

  await client.query(
    `
      INSERT INTO question_gaps (question_id, summary, source, note)
      VALUES ${valuesClause(gaps.length, 4)}
    `,
    gaps.flatMap((gap) => [questionId, gap.summary, gap.source, gap.note ?? null])
  );
}

// Inserts one row per citation in a single multi-row INSERT (instead of one
// round-trip per citation). `record()` may re-insert a citation for a section
// already cited by an earlier (e.g. retried) write, so it opts into the
// ON CONFLICT upsert; `updateAnswer()` deletes the question's prior citations
// first, so a plain insert is sufficient (and exact-matches the prior
// behavior, which did not upsert there either).
async function insertCitationRows(
  client: pg.PoolClient,
  questionId: string,
  citations: Citation[],
  options: { onConflictUpdate: boolean }
): Promise<void> {
  if (citations.length === 0) {
    return;
  }

  const conflictClause = options.onConflictUpdate
    ? `
        ON CONFLICT (question_id, section_id) DO UPDATE
        SET document_id = EXCLUDED.document_id,
            path = EXCLUDED.path,
            heading = EXCLUDED.heading,
            anchor = EXCLUDED.anchor,
            excerpt = EXCLUDED.excerpt
      `
    : "";

  await client.query(
    `
      INSERT INTO answer_citations (
        question_id, section_id, document_id, path, heading, anchor, excerpt
      )
      VALUES ${valuesClause(citations.length, 7)}
      ${conflictClause}
    `,
    citations.flatMap((citation) => [
      questionId,
      citation.sectionId,
      citation.documentId,
      citation.path,
      citation.heading,
      citation.anchor,
      citation.excerpt
    ])
  );
}

// Advances the monotonic gap-catalog revision for one flow ('' is the
// un-routed/default flow). Called inside the same transaction as any change to
// that flow's unresolved candidate gaps so the reconciler can gate model work on
// it. Upserts so a flow that has never had a gap still gets its first revision.
async function bumpGapCatalog(client: pg.PoolClient, flowId: string | null): Promise<void> {
  await client.query(
    `
      INSERT INTO gap_catalog (flow_id, revision) VALUES ($1, 1)
      ON CONFLICT (flow_id) DO UPDATE SET revision = gap_catalog.revision + 1
    `,
    [flowId ?? ""]
  );
}

// The gaps carried on an answer, each preserving its source ("auto" for a
// whole-question miss, "followup" for missing supporting material a confident
// answer searched for and could not find). Empty and non-seedable summaries (the
// echoed no-source-material fallback) are dropped so they never become a gap row,
// cluster, or proposal — isSeedableGapSummary is shared with the in-memory store.
function answerGapRows(answer: AnswerResult | undefined): Array<{ summary: string; source: QuestionGapSource }> {
  return (answer?.gaps ?? [])
    .map((gap) => ({ summary: gap.summary.trim(), source: gap.source }))
    .filter((gap) => gap.summary.length > 0 && isSeedableGapSummary(gap.summary));
}

// ILIKE pattern for a case-insensitive substring match on the question text, or
// null (no filter) when the search is blank. The term's own %/_/\ characters are
// escaped so they match literally — the console's search is a plain substring,
// not a pattern language.
function searchPattern(search: string | undefined): string | null {
  const trimmed = search?.trim();
  if (!trimmed) {
    return null;
  }
  return `%${trimmed.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

interface QuestionRow {
  id: string;
  question: string;
  confidence: Confidence;
  answer: string | null;
  chat_provider: string;
  flow_id: string | null;
  metadata: {
    answer?: AnswerResult | null;
    retrievedSectionIds?: string[];
  };
  feedback: QuestionFeedback | null;
  feedback_at: Date | null;
  manual_gap: boolean;
  manual_gap_at: Date | null;
  asked_at: Date;
  purpose: "live" | "verification";
}

interface GapCandidateRow {
  summary: string;
  flow_id: string;
  question_ids: string[];
  count: number;
  latest_asked_at: Date;
}

function mapQuestionRow(row: QuestionRow, gaps: QuestionGap[]): QuestionLog {
  const answer = row.metadata.answer ?? undefined;
  return {
    id: row.id,
    question: row.question,
    chatProvider: row.chat_provider,
    confidence: row.confidence,
    retrievedSectionIds: row.metadata.retrievedSectionIds ?? [],
    answer,
    askedAt: row.asked_at.toISOString(),
    ...(row.flow_id ? { flowId: row.flow_id } : {}),
    feedback: row.feedback ?? undefined,
    feedbackAt: row.feedback_at?.toISOString(),
    gaps,
    manualGap: row.manual_gap,
    manualGapAt: row.manual_gap_at?.toISOString(),
    purpose: row.purpose
  };
}
