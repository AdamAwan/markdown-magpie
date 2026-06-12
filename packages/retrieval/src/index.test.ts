import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DocumentSection } from "@magpie/core";
import { answerQuestion, MockChatProvider, type SectionSearchProvider } from "./index.js";

describe("answerQuestion", () => {
  it("returns a low-confidence gap when no sections match", async () => {
    const searchProvider: SectionSearchProvider = {
      async search() {
        return [];
      }
    };

    const result = await answerQuestion("How do I roll back a hotfix?", searchProvider, new MockChatProvider());

    assert.equal(result.confidence, "low");
    assert.equal(result.citations.length, 0);
    assert.equal(result.gap?.summary, "No source material found for: How do I roll back a hotfix?");
  });

  it("answers from relevant retrieved sections with citations", async () => {
    const sections: DocumentSection[] = [
      {
        id: "repo:runbook.md:0",
        documentId: "repo:runbook.md",
        path: "runbook.md",
        heading: "Hotfix Rollback",
        headingPath: ["Hotfix Rollback"],
        anchor: "hotfix-rollback",
        content: "Run the rollback workflow and notify the incident lead.",
        ordinal: 0
      },
      {
        id: "repo:release.md:0",
        documentId: "repo:release.md",
        path: "release.md",
        heading: "Release Checks",
        headingPath: ["Release Checks"],
        anchor: "release-checks",
        content: "Verify monitoring after every release.",
        ordinal: 0
      }
    ];
    const searchProvider: SectionSearchProvider = {
      async search(question, limit) {
        assert.equal(question, "How do I rollback?");
        assert.equal(limit, 5);
        return sections;
      }
    };

    const result = await answerQuestion("How do I rollback?", searchProvider, new MockChatProvider());

    assert.equal(result.confidence, "medium");
    assert.equal(result.gap, undefined);
    assert.equal(result.citations.length, 1);
    assert.equal(result.citations[0].sectionId, "repo:runbook.md:0");
    assert.match(result.answer, /rollback guidance is/i);
  });

  it("raises a gap when retrieved sections only have weak incidental overlap", async () => {
    const sections: DocumentSection[] = [
      {
        id: "repo:care.md:0",
        documentId: "repo:care.md",
        path: "care.md",
        heading: "Cat Care Basics",
        headingPath: ["Cat Care Basics"],
        anchor: "cat-care-basics",
        content: "Cats need fresh water, routine feeding, and a clean litter box.",
        ordinal: 0
      },
      {
        id: "repo:adoption.md:0",
        documentId: "repo:adoption.md",
        path: "adoption.md",
        heading: "Cat Adoption Checklist",
        headingPath: ["Cat Adoption Checklist"],
        anchor: "cat-adoption-checklist",
        content: "Prepare a quiet room before bringing a cat home.",
        ordinal: 0
      }
    ];
    const searchProvider: SectionSearchProvider = {
      async search() {
        return sections;
      }
    };

    const result = await answerQuestion("What should I do if a cat gets gum in their fur?", searchProvider, new MockChatProvider());

    assert.equal(result.confidence, "low");
    assert.equal(result.citations.length, 0);
    assert.equal(result.gap?.summary, "No source material found for: What should I do if a cat gets gum in their fur?");
  });

  it("raises a gap when the chat provider says the context is insufficient", async () => {
    const sections: DocumentSection[] = [
      {
        id: "repo:care.md:0",
        documentId: "repo:care.md",
        path: "care.md",
        heading: "Gum in Fur",
        headingPath: ["Gum in Fur"],
        anchor: "gum-in-fur",
        content: "Escalate sticky fur issues when the knowledge base has a reviewed procedure.",
        ordinal: 0
      }
    ];
    const searchProvider: SectionSearchProvider = {
      async search() {
        return sections;
      }
    };

    const result = await answerQuestion("What about gum in fur?", searchProvider, {
      async complete() {
        return {
          content: "The provided knowledge base does not contain any information about what to do if a cat gets gum in their fur."
        };
      }
    });

    assert.equal(result.confidence, "low");
    assert.equal(result.citations.length, 0);
    assert.match(result.gap?.summary ?? "", /No sufficient source material/);
  });
});
