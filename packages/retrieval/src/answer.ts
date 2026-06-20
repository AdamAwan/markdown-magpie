import type {
  AnswerResult,
  ChatProvider,
  Citation,
  Confidence,
  DocumentSection,
  KnowledgeGapSignal,
  RankedSection
} from "@magpie/core";
import { ANSWER_QUESTION, withPersona } from "@magpie/prompts";
import { parseJsonObject } from "./parse.js";

export interface SectionSearchProvider {
  search(question: string, limit: number, repositoryIds?: string[]): Promise<RankedSection[]>;
}

const RELEVANCE_FLOOR = 0.2;
const HIGH_CONFIDENCE_RELEVANCE = 0.6;
const MEDIUM_CONFIDENCE_RELEVANCE = 0.35;

export interface AnswerQuestionOptions {
  // Restrict retrieval to these repositories (a flow's destination). Undefined searches everything.
  repositoryIds?: string[];
  // Persona snippet appended to the base answer prompt to shape the response.
  persona?: string;
}

export async function answerQuestion(
  question: string,
  searchProvider: SectionSearchProvider,
  chatProvider: ChatProvider,
  options: AnswerQuestionOptions = {}
): Promise<AnswerResult> {
  const ranked = await searchProvider.search(question, 5, options.repositoryIds);
  const relevantSections = selectRelevantSections(ranked);
  const citations = relevantSections.map((result) => toCitation(result.section));

  if (relevantSections.length === 0) {
    return {
      answer: "I could not find reliable source material for this question.",
      confidence: "low",
      citations: [],
      gaps: [toGapSignal(`No source material found for: ${question}`, question, [])]
    };
  }

  const context = relevantSections.map(({ section }) => `# ${section.heading}\n${section.content}`).join("\n\n");
  const response = await chatProvider.complete({
    system: withPersona(ANSWER_QUESTION.instructions, options.persona),
    messages: [
      {
        role: "user",
        content: `Question:\n${question}\n\nContext:\n${context}`
      }
    ]
  });
  const structuredResponse = parseStructuredAnswerResponse(response.content);

  if (structuredResponse?.isKnowledgeGap) {
    const citedSectionIds = citations.map((citation) => citation.sectionId);
    const summaries = structuredResponse.gaps.length
      ? structuredResponse.gaps
      : [`No sufficient source material found for: ${question}`];
    return {
      answer: structuredResponse.answer,
      confidence: "low",
      citations,
      gaps: summaries.map((summary) => toGapSignal(summary, question, citedSectionIds))
    };
  }

  if (structuredResponse) {
    return {
      answer: structuredResponse.answer,
      confidence: structuredResponse.confidence,
      citations
    };
  }

  if (isKnowledgeGapAnswer(response.content)) {
    return {
      answer: response.content,
      confidence: "low",
      citations: [],
      gaps: [toGapSignal(`No sufficient source material found for: ${question}`, question, [])]
    };
  }

  return {
    answer: response.content,
    confidence: confidenceFromRelevance(relevantSections),
    citations
  };
}

function selectRelevantSections(ranked: RankedSection[]): RankedSection[] {
  const best = Math.max(0, ...ranked.map((result) => result.relevance));
  if (best < RELEVANCE_FLOOR) {
    return [];
  }

  const threshold = Math.max(RELEVANCE_FLOOR, best * 0.5);
  return ranked.filter((result) => result.relevance >= threshold).slice(0, 3);
}

function confidenceFromRelevance(selected: RankedSection[]): Confidence {
  const best = Math.max(0, ...selected.map((result) => result.relevance));
  if (best >= HIGH_CONFIDENCE_RELEVANCE && selected.length >= 2) {
    return "high";
  }

  return best >= MEDIUM_CONFIDENCE_RELEVANCE ? "medium" : "low";
}

interface StructuredAnswerResponse {
  answer: string;
  confidence: "high" | "medium" | "low";
  isKnowledgeGap: boolean;
  gaps: string[];
}

function parseStructuredAnswerResponse(value: string): StructuredAnswerResponse | undefined {
  const parsed = parseJsonObject(value);
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }

  const candidate = parsed as Partial<StructuredAnswerResponse> & { gapSummary?: unknown };
  if (
    typeof candidate.answer !== "string" ||
    (candidate.confidence !== "high" && candidate.confidence !== "medium" && candidate.confidence !== "low") ||
    typeof candidate.isKnowledgeGap !== "boolean"
  ) {
    return undefined;
  }

  return {
    answer: candidate.answer,
    confidence: candidate.isKnowledgeGap ? "low" : candidate.confidence,
    isKnowledgeGap: candidate.isKnowledgeGap,
    gaps: parseGapSummaries(candidate.gaps, candidate.gapSummary)
  };
}

// The model is asked for a "gaps" array, but tolerate the older singular
// "gapSummary" string so a stale provider prompt still yields one gap. Blank
// entries are dropped; callers fall back to a generated summary when empty.
function parseGapSummaries(gaps: unknown, legacyGapSummary: unknown): string[] {
  const collected: string[] = [];
  if (Array.isArray(gaps)) {
    for (const entry of gaps) {
      if (typeof entry === "string" && entry.trim().length > 0) {
        collected.push(entry.trim());
      }
    }
  }

  if (collected.length === 0 && typeof legacyGapSummary === "string" && legacyGapSummary.trim().length > 0) {
    collected.push(legacyGapSummary.trim());
  }

  return collected;
}

function toGapSignal(summary: string, question: string, citedSectionIds: string[]): KnowledgeGapSignal {
  return { summary, question, confidence: "low", citedSectionIds };
}

function isKnowledgeGapAnswer(value: string): boolean {
  return /provided knowledge base does not contain|does not contain any information|could not find reliable source material|not enough (?:source|context|information)|none of the sections/i.test(
    value
  );
}

function toCitation(section: DocumentSection): Citation {
  return {
    documentId: section.documentId,
    sectionId: section.id,
    path: section.path,
    heading: section.heading,
    anchor: section.anchor,
    excerpt: section.content.slice(0, 280)
  };
}
