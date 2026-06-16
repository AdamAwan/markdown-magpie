import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DocumentSection, RankedSection } from "@magpie/core";
import { answerQuestion, MockChatProvider, type SectionSearchProvider } from "./index.js";

function section(id: string, heading: string, content: string): DocumentSection {
  return {
    id,
    documentId: id.split(":").slice(0, 2).join(":"),
    path: `${heading.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`,
    heading,
    headingPath: [heading],
    anchor: heading.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    content,
    ordinal: 0
  };
}

function provider(ranked: RankedSection[], expect?: { question: string; limit: number }): SectionSearchProvider {
  return {
    async search(question, limit) {
      if (expect) {
        assert.equal(question, expect.question);
        assert.equal(limit, expect.limit);
      }
      return ranked;
    }
  };
}

describe("answerQuestion", () => {
  it("returns a low-confidence gap when no sections match", async () => {
    const result = await answerQuestion("How do I roll back a hotfix?", provider([]), new MockChatProvider());
    assert.equal(result.confidence, "low");
    assert.equal(result.citations.length, 0);
    assert.equal(result.gaps?.length, 1);
    assert.equal(result.gaps?.[0].summary, "No source material found for: How do I roll back a hotfix?");
  });

  it("answers from relevant retrieved sections with citations", async () => {
    const ranked: RankedSection[] = [
      { section: section("repo:runbook.md:0", "Hotfix Rollback", "Run the rollback workflow and notify the incident lead."), relevance: 0.5 },
      { section: section("repo:release.md:0", "Release Checks", "Verify monitoring after every release."), relevance: 0.1 }
    ];

    const result = await answerQuestion(
      "How do I rollback?",
      provider(ranked, { question: "How do I rollback?", limit: 5 }),
      new MockChatProvider()
    );

    assert.equal(result.confidence, "medium");
    assert.equal(result.gaps, undefined);
    assert.equal(result.citations.length, 1); // 0.1 is below the relative band, dropped
    assert.equal(result.citations[0].sectionId, "repo:runbook.md:0");
    assert.match(result.answer, /rollback guidance is/i);
  });

  it("selects sections by provided relevance even with no lexical overlap", async () => {
    const ranked: RankedSection[] = [
      { section: section("repo:felines.md:0", "Grooming", "Sticky residue is removed with oil before bathing."), relevance: 0.7 }
    ];

    const result = await answerQuestion("What do I do about gum stuck in fur?", provider(ranked), new MockChatProvider());

    assert.notEqual(result.confidence, "low");
    assert.equal(result.citations.length, 1);
    assert.equal(result.citations[0].sectionId, "repo:felines.md:0");
  });

  it("raises a gap when the best relevance is below the floor", async () => {
    const ranked: RankedSection[] = [
      { section: section("repo:care.md:0", "Cat Care Basics", "Cats need fresh water and a clean litter box."), relevance: 0.1 }
    ];

    const result = await answerQuestion("What should I do if a cat gets gum in their fur?", provider(ranked), new MockChatProvider());

    assert.equal(result.confidence, "low");
    assert.equal(result.citations.length, 0);
    assert.equal(result.gaps?.[0].summary, "No source material found for: What should I do if a cat gets gum in their fur?");
  });

  it("gates on the highest relevance, not the first element's (results may be ordered by fusion)", async () => {
    // Simulates hybrid output: array ordered by fused score, so the strongest-relevance
    // section is NOT first. The weak first item must not cause the strong one to be dropped.
    const ranked: RankedSection[] = [
      { section: section("repo:weak.md:0", "Weak Hit", "Tangentially related sentence."), relevance: 0.15 },
      { section: section("repo:strong.md:0", "Strong Hit", "Directly answers the question in detail."), relevance: 0.5 }
    ];

    const result = await answerQuestion("the question", provider(ranked), new MockChatProvider());

    assert.notEqual(result.confidence, "low");
    assert.equal(result.citations.length, 1);
    assert.equal(result.citations[0].sectionId, "repo:strong.md:0");
  });

  it("raises a gap when the chat provider says the context is insufficient", async () => {
    const ranked: RankedSection[] = [
      { section: section("repo:care.md:0", "Gum in Fur", "Escalate sticky fur issues when a reviewed procedure exists."), relevance: 0.5 }
    ];

    const result = await answerQuestion("What about gum in fur?", provider(ranked), {
      async complete() {
        return {
          content: "The provided knowledge base does not contain any information about what to do if a cat gets gum in their fur."
        };
      }
    });

    assert.equal(result.confidence, "low");
    assert.equal(result.citations.length, 0);
    assert.match(result.gaps?.[0].summary ?? "", /No sufficient source material/);
  });

  it("uses structured model gap decisions instead of retrieval confidence", async () => {
    const ranked: RankedSection[] = [
      {
        section: section(
          "repo:care.md:0",
          "Cat Care Basics",
          "Cats need consistent food, fresh water, a clean litter box, and routine attention."
        ),
        relevance: 0.5
      },
      {
        section: section("repo:health.md:1", "Vet Care", "Cats should have regular veterinary checkups and preventive care."),
        relevance: 0.5
      }
    ];

    const result = await answerQuestion("How do I know if a cat needs urgent care?", provider(ranked), {
      async complete() {
        return {
          content: JSON.stringify({
            answer: "The provided context does not explain how to identify when a cat needs urgent care.",
            confidence: "low",
            isKnowledgeGap: true,
            // Legacy singular field is still tolerated and wrapped into one gap.
            gapSummary: "No urgent cat care triage guidance is documented."
          })
        };
      }
    });

    assert.equal(result.confidence, "low");
    assert.equal(result.gaps?.length, 1);
    assert.equal(result.gaps?.[0].summary, "No urgent cat care triage guidance is documented.");
    assert.deepEqual(result.gaps?.[0].citedSectionIds, ["repo:care.md:0", "repo:health.md:1"]);
  });

  it("splits a multi-topic question into one gap per missing topic", async () => {
    const ranked: RankedSection[] = [
      {
        section: section("repo:setup.md:0", "Getting Started", "Install the package and add the provider to your app root."),
        relevance: 0.5
      }
    ];

    const result = await answerQuestion("How do I set this up with React so I can export dashboards?", provider(ranked), {
      async complete() {
        return {
          content: JSON.stringify({
            answer: "The context covers installation but not React integration or dashboard export.",
            confidence: "low",
            isKnowledgeGap: true,
            gaps: ["No React integration guidance is documented.", "Dashboard export is not documented."]
          })
        };
      }
    });

    assert.equal(result.confidence, "low");
    assert.equal(result.gaps?.length, 2);
    assert.deepEqual(
      result.gaps?.map((gap) => gap.summary),
      ["No React integration guidance is documented.", "Dashboard export is not documented."]
    );
    // Every gap from one answer shares that answer's citations.
    assert.deepEqual(result.gaps?.[1].citedSectionIds, ["repo:setup.md:0"]);
  });
});
