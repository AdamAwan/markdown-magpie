import type { AnswerResult, ChatProvider, Citation, ChatRequest, DocumentSection, EmbeddingProvider } from "@magpie/core";

export interface SectionSearchProvider {
  search(question: string, limit: number): Promise<DocumentSection[]>;
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

export class MockEmbeddingProvider implements EmbeddingProvider {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => [text.length]);
  }
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

export async function answerQuestion(
  question: string,
  searchProvider: SectionSearchProvider,
  chatProvider: ChatProvider
): Promise<AnswerResult> {
  const sections = await searchProvider.search(question, 5);
  const citations = sections.map(toCitation);

  if (sections.length === 0) {
    return {
      answer: "I could not find reliable source material for this question.",
      confidence: "low",
      citations: [],
      gap: {
        summary: `No source material found for: ${question}`,
        question,
        confidence: "low",
        citedSectionIds: []
      }
    };
  }

  const context = sections.map((section) => `# ${section.heading}\n${section.content}`).join("\n\n");
  const response = await chatProvider.complete({
    system: "Answer using only the provided Markdown knowledge base context. Cite the source sections.",
    messages: [
      {
        role: "user",
        content: `Question:\n${question}\n\nContext:\n${context}`
      }
    ]
  });

  return {
    answer: response.content,
    confidence: sections.length >= 2 ? "medium" : "low",
    citations
  };
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
