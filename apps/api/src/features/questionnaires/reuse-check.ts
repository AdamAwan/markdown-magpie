import type { QuestionnaireChangeReason, QuestionnaireItem } from "@magpie/core";
import type { SectionFingerprint } from "../../stores/postgres-knowledge-store.js";

// How many top hits the newcomer probe inspects. Only sections that are NEWER
// than the prior answer can trigger a refresh, so a larger k costs nothing on a
// quiet KB; 8 comfortably covers the answer pipeline's retrieval width.
const NEWCOMER_TOP_K = 8;

// The reuse check's two views of the world, injected so the algorithm is
// testable without Postgres. `fingerprints` resolves current section identity
// (absent id = section gone — the safe direction); `retrieveTopK` runs the
// existing hybrid search (inline, embeddings only — never a chat model) and
// returns undefined only on a retrieval-scope failure.
export interface ReuseCheckDeps {
  fingerprints(sectionIds: string[]): Promise<SectionFingerprint[]>;
  retrieveTopK(
    question: string,
    limit: number
  ): Promise<Array<{ sectionId: string; path: string; heading: string }> | undefined>;
}

export type ReuseDecision = { reuse: true } | { reuse: false; reason: QuestionnaireChangeReason };

// The core questionnaire-mode algorithm (spec 2026-07-16): a matched prior
// answer is reused VERBATIM iff
//   1. every section it cited is byte-unchanged (its claims still hold), and
//   2. nothing relevant to the question is newer than the answer (it is not
//      incomplete — the "new certificate file" case).
// Check 2 compares against the prior answer's ORIGINAL generation time, never a
// later reuse time: content that changed between two questionnaires but only
// became retrieval-relevant later must still trigger a refresh.
export async function checkReuse(
  deps: ReuseCheckDeps,
  prior: QuestionnaireItem,
  question: string
): Promise<ReuseDecision> {
  const answeredAt = prior.answeredAt;
  if (!answeredAt || prior.citations.length === 0 || prior.staleAtApproval) {
    // No verifiable provenance (or known-stale at approval): never reuse. An
    // uncited answer can't prove its claims still hold.
    const first = prior.citations[0];
    return {
      reuse: false,
      reason: {
        kind: "section_missing",
        sectionId: first?.sectionId ?? "",
        path: first?.path ?? "",
        heading: first?.heading ?? ""
      }
    };
  }

  // Check 1: every snapshotted citation still exists with identical content.
  const current = await deps.fingerprints(prior.citations.map((citation) => citation.sectionId));
  const currentById = new Map(current.map((fingerprint) => [fingerprint.sectionId, fingerprint]));
  for (const cited of prior.citations) {
    const now = currentById.get(cited.sectionId);
    if (!now) {
      return {
        reuse: false,
        reason: { kind: "section_missing", sectionId: cited.sectionId, path: cited.path, heading: cited.heading }
      };
    }
    if (now.contentHash !== cited.contentHash) {
      return {
        reuse: false,
        reason: {
          kind: "section_changed",
          sectionId: cited.sectionId,
          path: cited.path,
          heading: cited.heading,
          changedAt: now.contentChangedAt
        }
      };
    }
  }

  // Check 2: no top-k hit is newer than the answer. Rank shuffles among
  // old sections can never trigger this; genuinely newer content always does.
  const hits = await deps.retrieveTopK(question, NEWCOMER_TOP_K);
  if (!hits) {
    return { reuse: false, reason: { kind: "new_content", sectionId: "", path: "", heading: "" } };
  }
  if (hits.length > 0) {
    const hitFingerprints = await deps.fingerprints(hits.map((hit) => hit.sectionId));
    for (const fingerprint of hitFingerprints) {
      if (fingerprint.contentChangedAt > answeredAt) {
        const hit = hits.find((candidate) => candidate.sectionId === fingerprint.sectionId);
        return {
          reuse: false,
          reason: {
            kind: "new_content",
            sectionId: fingerprint.sectionId,
            path: hit?.path ?? "",
            heading: hit?.heading ?? "",
            changedAt: fingerprint.contentChangedAt
          }
        };
      }
    }
  }

  return { reuse: true };
}
