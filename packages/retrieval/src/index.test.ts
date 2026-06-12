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

  it("answers from retrieved sections with citations", async () => {
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
    assert.equal(result.citations.length, 2);
    assert.equal(result.citations[0].sectionId, "repo:runbook.md:0");
    assert.match(result.answer, /rollback guidance is/i);
  });
});
