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

  it("parses CRLF frontmatter and keeps it out of the body", () => {
    const parsed = parseMarkdownDocument("---\r\ntitle: X\r\nowner: ops\r\n---\r\nbody");

    assert.equal(parsed.metadata.title, "X");
    assert.equal(parsed.metadata.owner, "ops");
    assert.equal(parsed.body.trim(), "body");
    assert.ok(!parsed.body.includes("title: X"));
  });
});

function makeDocument(content: string): KnowledgeDocument {
  return {
    id: "repo:doc.md",
    repositoryId: "repo",
    path: "doc.md",
    metadata: {
      title: "Doc",
      status: "active",
      tags: [],
      relatedDocs: []
    },
    content
  };
}

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

  it("does not treat # lines inside a code fence as headings", () => {
    const sections = splitIntoSections(
      makeDocument("# Deploy\n\nRun this:\n\n```sh\n# comment, not a heading\nnpm run deploy\n```\n\nDone.")
    );

    assert.equal(sections.length, 1);
    assert.equal(sections[0].heading, "Deploy");
    assert.ok(sections[0].content.includes("# comment, not a heading"));
  });

  it("does not treat # lines inside a tilde code fence as headings", () => {
    const sections = splitIntoSections(makeDocument("# Top\n\n~~~\n# still code\n~~~\n"));

    assert.equal(sections.length, 1);
    assert.equal(sections[0].heading, "Top");
  });

  it("de-duplicates anchors for repeated headings", () => {
    const sections = splitIntoSections(makeDocument("# Notes\n\nFirst.\n\n# Notes\n\nSecond."));

    assert.equal(sections.length, 2);
    assert.equal(sections[0].anchor, "notes");
    assert.equal(sections[1].anchor, "notes-2");
  });

  it("falls back to a non-empty anchor for symbol-only headings", () => {
    const sections = splitIntoSections(makeDocument("# 🎉✨\n\nCelebrate."));

    assert.equal(sections.length, 1);
    assert.ok(sections[0].anchor.length > 0);
    assert.equal(sections[0].anchor, "section-0");
  });

  it("emits no sections for an empty document", () => {
    assert.deepEqual(splitIntoSections(makeDocument("")), []);
  });

  it("emits a section for a heading-only document", () => {
    const sections = splitIntoSections(makeDocument("---\ntitle: T\n---\n# Title\n"));

    assert.equal(sections.length, 1);
    assert.equal(sections[0].heading, "Title");
    assert.deepEqual(sections[0].headingPath, ["Title"]);
    assert.equal(sections[0].anchor, "title");
  });

  it("compacts the heading stack for a document starting at ##", () => {
    const sections = splitIntoSections(makeDocument("## Sub\n\nBody."));

    assert.equal(sections.length, 1);
    assert.deepEqual(sections[0].headingPath, ["Sub"]);
    assert.equal(sections[0].anchor, "sub");
    assert.ok(!sections[0].anchor.startsWith("-"));
  });
});
