import type { AnswerResult, ChatProvider, Citation, DocumentSection, EmbeddingProvider } from "@magpie/core";

export interface SectionSearchProvider {
  search(question: string, limit: number): Promise<DocumentSection[]>;
}

export class MockEmbeddingProvider implements EmbeddingProvider {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => [text.length]);
  }
}

export class MockChatProvider implements ChatProvider {
  async complete(): Promise<{ content: string }> {
    return {
      content: "I found related knowledge, but no real chat provider is configured yet."
    };
  }
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
