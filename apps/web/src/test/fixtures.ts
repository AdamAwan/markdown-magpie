import type {
  Citation,
  GapCandidate,
  JobView,
  KnowledgeDocument,
  QuestionLog,
  RuntimeConfig,
  SuggestedGapCluster,
  WatcherView
} from "../lib/types";

// Typed builders for the domain objects the console tests pass around. Each
// returns a complete, valid object so a test only spells out what it is about.

export const FIXTURE_TIME = "2026-06-22T20:00:00.000Z";

export function jobFixture(overrides: Partial<JobView> = {}): JobView {
  return {
    id: "job-1",
    type: "answer_question",
    queueName: "ai:codex",
    deadLetter: false,
    state: "completed",
    input: {},
    retryCount: 0,
    retryLimit: 3,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    expireInSeconds: 300,
    ...overrides
  };
}

export function citationFixture(overrides: Partial<Citation> = {}): Citation {
  return {
    documentId: "kb:cats.md",
    sectionId: "kb:cats.md#warning-signs",
    path: "cats.md",
    heading: "Warning signs",
    anchor: "warning-signs",
    excerpt: "Laboured breathing is always urgent.",
    relevance: 0.82,
    ...overrides
  };
}

export function questionFixture(overrides: Partial<QuestionLog> = {}): QuestionLog {
  return {
    id: "question-1",
    question: "What are urgent cat warning signs?",
    chatProvider: "codex",
    confidence: "high",
    retrievedSectionIds: [],
    askedAt: FIXTURE_TIME,
    ...overrides
  };
}

export function documentFixture(
  overrides: Omit<Partial<KnowledgeDocument>, "metadata"> & { metadata?: Partial<KnowledgeDocument["metadata"]> } = {}
): KnowledgeDocument {
  const { metadata, ...rest } = overrides;
  return {
    id: "billing-kb:rates.md",
    repositoryId: "billing-kb",
    path: "rates.md",
    content: "# Rates\n\nTiered pricing.",
    ...rest,
    metadata: { title: "Rates", status: "active", tags: [], relatedDocs: [], ...metadata }
  };
}

export function gapFixture(overrides: Partial<GapCandidate> = {}): GapCandidate {
  return {
    summary: "How are refunds processed?",
    questionIds: ["question-1"],
    count: 1,
    latestAskedAt: FIXTURE_TIME,
    confidence: "low",
    ...overrides
  };
}

export function clusterFixture(overrides: Partial<SuggestedGapCluster> = {}): SuggestedGapCluster {
  return {
    id: "cluster-1",
    title: "Refunds",
    summaries: ["How are refunds processed?"],
    questionIds: ["question-1"],
    count: 1,
    ...overrides
  };
}

export function workerFixture(overrides: Partial<WatcherView> = {}): WatcherView {
  return {
    name: "watcher-a",
    status: "idle",
    capabilities: [],
    lastSeenAt: FIXTURE_TIME,
    ...overrides
  };
}

/** A two-flow runtime config: billing (two sources, a persona) and support. */
export function configFixture(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    api: {},
    stores: {},
    knowledge: {
      repositoryPath: null,
      sources: [
        { id: "product-repo", name: "Product repo", kind: "git", url: "https://example.test/product.git" },
        { id: "crawler", name: "Crawler", kind: "agent" }
      ],
      destinations: [
        { id: "billing-kb", name: "Billing KB", path: "/kb/billing", branch: "main", subpath: "docs" },
        { id: "support-kb", name: "Support KB", path: "/kb/support" }
      ],
      flows: [
        {
          id: "billing",
          name: "Billing",
          sourceIds: ["product-repo", "crawler"],
          destinationId: "billing-kb",
          persona: "Answer as a billing specialist."
        },
        { id: "support", name: "Support", sourceIds: [], destinationId: "support-kb" }
      ]
    },
    providers: {},
    aiRuntime: { provider: "codex" },
    retrieval: { mode: "keyword", reason: "No embedding provider configured.", embeddingProvider: null },
    watcher: {},
    ...overrides
  };
}
