import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assessCall,
  clauseCoverage,
  contentWords,
  coveringSection,
  FABRICATED_SOC2_CLAIM,
  groundedSentences,
  parseSections,
  routeCall,
  splitClauses,
  splitSentences,
  verifyCall
} from "./golden-core.mjs";

const RETENTION_SECTION =
  "[section repo:backups.md:2] # Backup retention\n" +
  "How long a backup is retained: nightly database backups are retained for 35\n" +
  "days. After 35 days a backup expires and is deleted permanently.";

const ANSWER_SYSTEM =
  "You answer a question using only the provided Markdown knowledge base context. …\n\n" +
  "Persona (how to look and respond):\n" +
  "You answer questions about the Aurora database product: backups, retention, deployment.\n\n" +
  "Ground rules…";

function assessMessage(question, context) {
  return `Question:\n${question}\n\nContext:\n${context}`;
}

describe("contentWords", () => {
  it("drops stopwords and folds plurals", () => {
    assert.deepEqual(contentWords("How long are database backups retained?"), [
      "long",
      "database",
      "backup",
      "retained"
    ]);
  });

  it("keeps hyphenated tokens whole", () => {
    assert.deepEqual(contentWords("the on-call engineer in eu-west"), ["on-call", "engineer", "eu-west"]);
  });

  it("matches stopwords before plural folding, so 'does' never becomes 'doe'", () => {
    assert.deepEqual(contentWords("Does Aurora support single sign-on?"), ["aurora", "support", "single", "sign-on"]);
  });
});

describe("splitClauses", () => {
  it("splits only on comma-and", () => {
    assert.deepEqual(splitClauses("How long are backups retained, and can they be restored from cold storage?"), [
      "How long are backups retained",
      "can they be restored from cold storage?"
    ]);
    assert.deepEqual(splitClauses("wet or dry food and treats"), ["wet or dry food and treats"]);
  });
});

describe("parseSections", () => {
  it("parses id, heading, and multi-line content", () => {
    const sections = parseSections(`${RETENTION_SECTION}\n\n[section repo:limits.md:1] # API rate limits\nThe API allows 120 requests per minute.\n\nExceeding it returns 429.`);
    assert.equal(sections.length, 2);
    assert.equal(sections[0].id, "repo:backups.md:2");
    assert.equal(sections[0].heading, "Backup retention");
    assert.ok(sections[0].content.includes("35"));
    assert.ok(sections[1].content.includes("Exceeding it returns 429."), "content keeps its blank lines");
  });

  it("returns nothing for the empty-context placeholder", () => {
    assert.deepEqual(parseSections("(no context retrieved yet)"), []);
  });
});

describe("clause coverage", () => {
  const section = parseSections(RETENTION_SECTION)[0];

  it("is full when every content word appears", () => {
    assert.equal(clauseCoverage("How long are database backups retained?", section), 1);
    assert.equal(coveringSection("How long are database backups retained?", [section]), section);
  });

  it("is partial when words are missing", () => {
    const coverage = clauseCoverage("can expired backups be restored from cold storage", section);
    assert.ok(coverage > 0 && coverage < 1, `expected partial coverage, got ${coverage}`);
    assert.equal(coveringSection("can expired backups be restored from cold storage", [section]), undefined);
  });
});

describe("groundedSentences", () => {
  it("keeps only sentences sharing a content word, whitespace-normalised", () => {
    const section = parseSections(RETENTION_SECTION)[0];
    const picked = groundedSentences("How long are database backups retained?", section);
    assert.ok(picked[0].startsWith("How long a backup is retained:"));
    assert.ok(picked.every((sentence) => !sentence.includes("\n")));
  });
});

describe("routeCall", () => {
  const flows = JSON.stringify([
    { id: "aurora", name: "Aurora Product Docs", persona: "Questions about the Aurora database product: backups, deployment." },
    { id: "handbook", name: "Engineering Handbook", persona: "Questions about onboarding new engineers and incident response." }
  ]);

  it("routes by keyword overlap", () => {
    const reply = routeCall(`Question:\nHow long are database backups retained?\n\nFlows:\n${flows}`);
    assert.equal(reply.flowId, "aurora");
    assert.equal(reply.confidence, "high");
  });

  it("abstains with null on zero overlap", () => {
    const reply = routeCall(`Question:\nShould I feed my cat wet or dry food?\n\nFlows:\n${flows}`);
    assert.equal(reply.flowId, null);
  });
});

describe("assessCall", () => {
  it("answers high with used section ids when the clause is fully covered", () => {
    const reply = assessCall(ANSWER_SYSTEM, assessMessage("How long are database backups retained?", RETENTION_SECTION));
    assert.equal(reply.action, "answer");
    assert.equal(reply.confidence, "high");
    assert.deepEqual(reply.usedSectionIds, ["repo:backups.md:2"]);
    assert.ok(reply.answer.includes("35"));
    assert.equal(reply.isKnowledgeGap, false);
  });

  it("requests a search for uncovered clauses", () => {
    const reply = assessCall(
      ANSWER_SYSTEM,
      assessMessage("How long are database backups retained, and can expired backups be restored from cold storage?", RETENTION_SECTION)
    );
    assert.equal(reply.action, "search");
    assert.deepEqual(reply.queries, ["expired backup restored cold storage"]);
  });

  it("answers medium with followup gaps when forced with a clause still uncovered", () => {
    const context = `${RETENTION_SECTION}\n\nYou have gathered enough context. Answer now using only the context above; do not request more searches.`;
    const reply = assessCall(
      ANSWER_SYSTEM,
      assessMessage("How long are database backups retained, and can expired backups be restored from cold storage?", context)
    );
    assert.equal(reply.action, "answer");
    assert.equal(reply.confidence, "medium");
    assert.equal(reply.followupGaps.length, 1);
    assert.ok(reply.answer.includes("35"));
    assert.ok(reply.answer.includes("The knowledge base does not cover:"));
  });

  it("declares a knowledge gap when forced with nothing covered but the question is in-domain", () => {
    const context = "(no context retrieved yet)\n\nYou have gathered enough context. Answer now using only the context above; do not request more searches.";
    const reply = assessCall(ANSWER_SYSTEM, assessMessage("What is the enterprise support SLA for the Aurora database?", context));
    assert.equal(reply.action, "answer");
    assert.equal(reply.isKnowledgeGap, true);
    assert.equal(reply.confidence, "low");
    assert.ok(reply.gaps.length >= 1);
  });

  it("goes out of scope when the question matches neither persona nor context", () => {
    const reply = assessCall(ANSWER_SYSTEM, assessMessage("Should I feed my cat wet or dry food?", "(no context retrieved yet)"));
    assert.equal(reply.action, "answer");
    assert.equal(reply.outOfScope, true);
    assert.deepEqual(reply.gaps, []);
  });

  it("appends the fabricated SOC 2 claim for the verification probe", () => {
    const section =
      "[section repo:security.md:2] # Compliance status\n" +
      "Aurora is not yet SOC 2 certified; a SOC 2 Type II audit is in progress.";
    const reply = assessCall(ANSWER_SYSTEM, assessMessage("Is Aurora SOC 2 certified?", section));
    assert.equal(reply.action, "answer");
    assert.ok(reply.answer.includes(FABRICATED_SOC2_CLAIM));
    assert.ok(reply.answer.includes("audit is in progress"));
  });
});

describe("verifyCall", () => {
  const context =
    "[section repo:security.md:2] # Compliance status\n" +
    "Aurora is not yet SOC 2 certified; a SOC 2 Type II audit is in progress.";

  it("confirms grounding when every sentence appears in a section", () => {
    const reply = verifyCall(
      `Question:\nIs Aurora SOC 2 certified?\n\nAnswer under review:\nAurora is not yet SOC 2 certified; a SOC 2 Type II audit is in progress.\n\nContext:\n${context}`
    );
    assert.equal(reply.grounded, true);
    assert.deepEqual(reply.unsupportedClaims, []);
  });

  it("strips fabricated sentences into a revised answer", () => {
    const answer = `Aurora is not yet SOC 2 certified; a SOC 2 Type II audit is in progress. ${FABRICATED_SOC2_CLAIM}`;
    const reply = verifyCall(`Question:\nIs Aurora SOC 2 certified?\n\nAnswer under review:\n${answer}\n\nContext:\n${context}`);
    assert.equal(reply.grounded, false);
    assert.deepEqual(reply.unsupportedClaims, [FABRICATED_SOC2_CLAIM]);
    assert.ok(reply.revisedAnswer.includes("audit is in progress"));
    assert.ok(!reply.revisedAnswer.includes("fully SOC 2 certified"));
  });

  it("treats coverage meta-statements as supported", () => {
    const answer = "How long a backup is retained: nightly database backups are retained for 35 days. The knowledge base does not cover: cold storage.";
    const reply = verifyCall(`Question:\nQ\n\nAnswer under review:\n${answer}\n\nContext:\n${RETENTION_SECTION}`);
    assert.equal(reply.grounded, true);
  });
});

describe("splitSentences", () => {
  it("normalises whitespace before splitting", () => {
    assert.deepEqual(splitSentences("One thing.\nTwo things!  Three?"), ["One thing.", "Two things!", "Three?"]);
  });
});
