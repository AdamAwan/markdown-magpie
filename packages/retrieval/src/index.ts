import type { AnswerResult, ChatProvider, Citation, ChatRequest, Confidence, DocumentSection, KnowledgeGapSignal, RankedSection } from "@magpie/core";

export interface SectionSearchProvider {
  search(question: string, limit: number): Promise<RankedSection[]>;
}

export type ChatProviderName = "mock" | "openai-compatible" | "azure-openai";

export interface ChatProviderConfig {
  provider: ChatProviderName;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  azureEndpoint?: string;
  azureDeployment?: string;
  azureApiVersion?: string;
}

export class MockChatProvider implements ChatProvider {
  async complete(request: ChatRequest): Promise<{ content: string }> {
    const prompt = request.messages.at(-1)?.content ?? "";
    const question = extractBlock(prompt, "Question") || "the question";
    const context = extractBlock(prompt, "Context");
    const firstRelevantParagraph = context
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("#"));

    if (!firstRelevantParagraph) {
      return {
        content: "I could not find reliable source material for this question."
      };
    }

    return {
      content: `Based on the indexed Markdown, ${answerLeadIn(question)} ${firstRelevantParagraph}`
    };
  }
}

export class OpenAICompatibleChatProvider implements ChatProvider {
  constructor(private readonly config: Required<Pick<ChatProviderConfig, "apiKey" | "baseUrl" | "model">>) {}

  async complete(request: ChatRequest): Promise<{ content: string }> {
    const response = await fetch(`${trimTrailingSlash(this.config.baseUrl)}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: "system", content: request.system },
          ...request.messages
        ],
        temperature: 0.2
      })
    });

    return parseChatCompletionResponse(response);
  }
}

export class AzureOpenAIChatProvider implements ChatProvider {
  constructor(
    private readonly config: Required<
      Pick<ChatProviderConfig, "apiKey" | "azureEndpoint" | "azureDeployment" | "azureApiVersion">
    >
  ) {}

  async complete(request: ChatRequest): Promise<{ content: string }> {
    const endpoint = trimTrailingSlash(this.config.azureEndpoint);
    const deployment = encodeURIComponent(this.config.azureDeployment);
    const apiVersion = encodeURIComponent(this.config.azureApiVersion);
    const response = await fetch(`${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`, {
      method: "POST",
      headers: {
        "api-key": this.config.apiKey,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: request.system },
          ...request.messages
        ],
        temperature: 0.2
      })
    });

    return parseChatCompletionResponse(response);
  }
}

export function createChatProvider(config: ChatProviderConfig): ChatProvider {
  if (config.provider === "openai-compatible") {
    assertConfig(config.apiKey, "OPENAI_COMPATIBLE_API_KEY");
    assertConfig(config.baseUrl, "OPENAI_COMPATIBLE_BASE_URL");
    assertConfig(config.model, "OPENAI_COMPATIBLE_MODEL");
    return new OpenAICompatibleChatProvider({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model
    });
  }

  if (config.provider === "azure-openai") {
    assertConfig(config.apiKey, "AZURE_OPENAI_API_KEY");
    assertConfig(config.azureEndpoint, "AZURE_OPENAI_ENDPOINT");
    assertConfig(config.azureDeployment, "AZURE_OPENAI_CHAT_DEPLOYMENT");
    return new AzureOpenAIChatProvider({
      apiKey: config.apiKey,
      azureEndpoint: config.azureEndpoint,
      azureDeployment: config.azureDeployment,
      azureApiVersion: config.azureApiVersion ?? "2024-10-21"
    });
  }

  return new MockChatProvider();
}

const RELEVANCE_FLOOR = 0.2;
const HIGH_CONFIDENCE_RELEVANCE = 0.6;
const MEDIUM_CONFIDENCE_RELEVANCE = 0.35;

export async function answerQuestion(
  question: string,
  searchProvider: SectionSearchProvider,
  chatProvider: ChatProvider
): Promise<AnswerResult> {
  const ranked = await searchProvider.search(question, 5);
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
    system:
      "Answer using only the provided Markdown knowledge base context. Return only JSON with this shape: " +
      '{"answer":"string","confidence":"high|medium|low","isKnowledgeGap":true|false,"gaps":["string"]}. ' +
      "Set isKnowledgeGap to true and confidence to low when the context does not specifically answer the question. " +
      'List each distinct piece of missing knowledge as its own entry in "gaps" — a question that asks about several ' +
      "unrelated topics should produce one gap per unanswered topic. Use an empty array when the answer is fully supported.",
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

function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(value);
    if (fenced) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        return undefined;
      }
    }

    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(value.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
  }

  return undefined;
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

async function parseChatCompletionResponse(response: Response): Promise<{ content: string }> {
  if (!response.ok) {
    throw new Error(`Chat provider failed with ${response.status}: ${await response.text()}`);
  }

  const body = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string;
      };
    }>;
  };
  const content = body.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("Chat provider returned no message content");
  }

  return { content };
}

function extractBlock(prompt: string, label: string): string {
  const pattern = new RegExp(`${label}:\\n([\\s\\S]*?)(?:\\n\\n[A-Z][A-Za-z ]+:\\n|$)`);
  return pattern.exec(prompt)?.[1]?.trim() ?? "";
}

function answerLeadIn(question: string): string {
  if (/rollback/i.test(question)) {
    return "rollback guidance is:";
  }

  if (/deploy|deployment/i.test(question)) {
    return "deployment guidance is:";
  }

  return "the relevant guidance is:";
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function assertConfig(value: string | undefined, name: string): asserts value is string {
  if (!value) {
    throw new Error(`${name} is required for the selected chat provider`);
  }
}

export * from "./rrf.js";
export * from "./embeddings.js";
