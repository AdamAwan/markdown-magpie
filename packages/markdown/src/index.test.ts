import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { KnowledgeDocument } from "@magpie/core";
import { parseMarkdownDocument, splitIntoSections } from "./index.js";

describe("parseMarkdownDocument", () => {
  it("parses simple frontmatter with defaults", () => {
    const parsed = parseMarkdownDocument(`---
title: Release Guide
owner: docs-team
status: draft
tags: [release, runbook]
review_cycle_days: 30
---
# Release Guide

Ship carefully.`);

    assert.equal(parsed.metadata.title, "Release Guide");
    assert.equal(parsed.metadata.owner, "docs-team");
    assert.equal(parsed.metadata.status, "draft");
    assert.deepEqual(parsed.metadata.tags, ["release", "runbook"]);
    assert.equal(parsed.metadata.reviewCycleDays, 30);
    assert.equal(parsed.body.trim(), "# Release Guide\n\nShip carefully.");
  });

  it("infers a title when frontmatter is absent", () => {
    const parsed = parseMarkdownDocument("# Incident Response\n\nCall the lead.");

    assert.equal(parsed.metadata.title, "Incident Response");
    assert.equal(parsed.metadata.status, "active");
  });
});

describe("splitIntoSections", () => {
  it("creates stable heading-based sections", () => {
    const document: KnowledgeDocument = {
      id: "repo:runbook.md",
      repositoryId: "repo",
      path: "runbook.md",
      metadata: {
        title: "Runbook",
        status: "active",
        tags: [],
        relatedDocs: []
      },
      content: "# Deploy\n\nUse the deploy workflow.\n\n## Rollback\n\nRun the rollback workflow."
    };

    const sections = splitIntoSections(document);

    assert.equal(sections.length, 2);
    assert.equal(sections[0].id, "repo:runbook.md:0");
    assert.equal(sections[0].heading, "Deploy");
    assert.deepEqual(sections[0].headingPath, ["Deploy"]);
    assert.equal(sections[0].anchor, "deploy");
    assert.equal(sections[1].heading, "Rollback");
    assert.deepEqual(sections[1].headingPath, ["Deploy", "Rollback"]);
    assert.equal(sections[1].anchor, "deploy-rollback");
  });
});
