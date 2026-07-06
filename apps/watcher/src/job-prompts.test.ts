import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JobView } from "@magpie/jobs";
import type { RetrievedSection } from "./http-client.js";
import {
  applyGroundingVerdict,
  buildAnswerOutput,
  buildPrompt,
  buildSourceGroundedPrompt,
  forcedSearchQueries,
  parseGroundingVerdict,
  parseJobOutput,
  UNPARSEABLE_ANSWER_FALLBACK
} from "./job-prompts.js";

function job(type: JobView["type"], input: unknown): JobView {
  return {
    id: "j",
    type,
    queueName: type,
    deadLetter: false,
    state: "active",
    input,
    retryCount: 0,
    retryLimit: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expireInSeconds: 300
  };
}

const SECTIONS: RetrievedSection[] = [
  {
    sectionId: "doc-1#deploy",
    documentId: "doc-1",
    anchor: "deploy",
    path: "ops/deploy.md",
    heading: "Deploy",
    content: "Run the deploy script then verify health.",
    relevance: 0.9
  }
];

describe("buildPrompt", () => {
  it("embeds the summarize_gap input as JSON", () => {
    const prompt = buildPrompt(job("summarize_gap", { questions: ["why?"], citedSections: [] }));
    assert.match(prompt, /why\?/);
  });

  it("uses the verify-document instructions for a verify_document job", () => {
    const prompt = buildPrompt(job("verify_document", { path: "kb/a.md", content: "x", sourcesRef: "h" }));
    assert.match(prompt, /verify a Markdown knowledge-base document/);
    assert.match(prompt, /"path"/);
  });

  it("uses the split-document instructions for a split_document job", () => {
    const prompt = buildPrompt(job("split_document", { path: "kb/a.md", content: "# A", neighbours: [] }));
    assert.match(prompt, /outgrown a single responsibility/);
    assert.match(prompt, /"neighbours"/);
  });

  it("uses the improve-document instructions for an improve_document job", () => {
    const prompt = buildPrompt(job("improve_document", { path: "kb/a.md", content: "# A", sourcesRef: "h" }));
    assert.match(prompt, /fine-but-thin/);
    assert.match(prompt, /"path"/);
  });

  it("renders a resolved corpus as a leading block and drops the bare sourcesRef", () => {
    const corpus = [
      { sourceId: "s1", sourceName: "Billing", kind: "git" as const, content: "partial refunds are supported" }
    ];
    const prompt = buildPrompt(job("verify_document", { path: "kb/a.md", content: "x", sourcesRef: "corpus-hash" }), corpus);
    // The shared corpus comes first (a stable cacheable prefix) and carries the material...
    assert.match(prompt, /^Source material \(shared across this batch\):/);
    assert.match(prompt, /partial refunds are supported/);
    // ...while the per-document input still follows the instructions,
    assert.match(prompt, /verify a Markdown knowledge-base document/);
    assert.match(prompt, /"path": "kb\/a.md"/);
    // ...and the now-redundant ref hash is not serialized into the input block.
    assert.doesNotMatch(prompt, /corpus-hash/);
    assert.doesNotMatch(prompt, /sourcesRef/);
  });

  it("keeps the corpus block identical across job types so the provider can cache it", () => {
    const corpus = [{ sourceId: "s1", sourceName: "Billing", kind: "git" as const, content: "refund policy" }];
    const verify = buildPrompt(job("verify_document", { path: "a.md", content: "x", sourcesRef: "h" }), corpus);
    const improve = buildPrompt(job("improve_document", { path: "b.md", content: "y", sourcesRef: "h" }), corpus);
    const block = (prompt: string): string => prompt.slice(0, prompt.indexOf("\n\n") + 1);
    assert.equal(block(verify), block(improve), "the leading corpus block is byte-identical across job types");
  });
});

describe("buildSourceGroundedPrompt", () => {
  const sourceGroundedJob = {
    id: "j1",
    type: "draft_seed_document",
    input: {
      provider: "openai-compatible",
      flowId: "f1",
      coverage: ["statement ingestion"],
      sources: [{ id: "s1", name: "Product repo", kind: "git", url: "https://example.com/r.git" }]
    }
  } as JobView;
  const workspaces = [{ sourceId: "s1", name: "Product repo", rootDir: "/checkouts/s1" }];

  it("lists workspaces, omits the sources field from the input JSON, and ends with the input", () => {
    const prompt = buildSourceGroundedPrompt(
      sourceGroundedJob,
      workspaces,
      ["Source \"X\" is unavailable (gone)."],
      "cli"
    );
    assert.match(prompt, /Product repo/);
    assert.match(prompt, /\/checkouts\/s1/);
    assert.match(prompt, /unavailable \(gone\)/);
    assert.doesNotMatch(prompt, /"sources"/);
    assert.ok(prompt.indexOf("statement ingestion") > prompt.indexOf("Product repo"));
  });

  it("describes tool-loop paths for the tools mode", () => {
    const prompt = buildSourceGroundedPrompt(sourceGroundedJob, workspaces, [], "tools");
    assert.match(prompt, /list_dir/);
    assert.match(prompt, /s1\//);
  });
});

describe("buildAnswerOutput", () => {
  it("derives citations from the retrieved sections, not the model", () => {
    const output = buildAnswerOutput(
      JSON.stringify({ answer: "Deploy then verify.", confidence: "high", isKnowledgeGap: false }),
      SECTIONS,
      "How do I deploy?",
      "flow-1"
    );
    assert.equal(output.answer, "Deploy then verify.");
    assert.equal(output.confidence, "high");
    assert.equal(output.flowId, "flow-1");
    assert.equal(output.citations.length, 1);
    assert.deepEqual(output.citations[0], {
      documentId: "doc-1",
      sectionId: "doc-1#deploy",
      path: "ops/deploy.md",
      heading: "Deploy",
      anchor: "deploy",
      excerpt: "Run the deploy script then verify health.",
      relevance: 0.9
    });
  });

  it("forces low confidence and emits a gap when the model flags a knowledge gap", () => {
    const output = buildAnswerOutput(
      JSON.stringify({ answer: "Not covered.", confidence: "high", isKnowledgeGap: true, gaps: ["no rollback docs"] }),
      SECTIONS,
      "How do I roll back?",
      undefined
    );
    assert.equal(output.confidence, "low");
    assert.ok(output.gaps && output.gaps.length === 1);
    assert.equal(output.gaps[0].summary, "no rollback docs");
    assert.equal(output.gaps[0].question, "How do I roll back?");
    assert.deepEqual(output.gaps[0].citedSectionIds, ["doc-1#deploy"]);
    assert.equal(output.gaps[0].source, "auto");
    assert.equal(output.flowId, undefined);
  });

  it("rejects an off-topic question with no gaps when the model flags outOfScope", () => {
    const output = buildAnswerOutput(
      JSON.stringify({
        answer: "This question is about cats, which is unrelated to this product knowledge base.",
        confidence: "low",
        isKnowledgeGap: false,
        outOfScope: true,
        gaps: []
      }),
      [],
      "Tell me about cats",
      "product-flow"
    );
    assert.equal(output.confidence, "unknown", "an off-topic answer is withheld at unknown confidence");
    assert.equal(output.gaps, undefined, "an off-topic question raises NO gaps");
    assert.deepEqual(output.citations, [], "an off-topic answer cites nothing");
    assert.ok(output.outOfScope, "the structured out-of-scope signal is set");
    assert.match(output.outOfScope.reason ?? "", /cats/i, "the reason carries the model's explanation");
    assert.equal(output.flowId, "product-flow", "the picked flow is still recorded");
  });

  it("does not fall through to an auto gap for an off-topic question with empty retrieval", () => {
    // Empty retrieval would normally force an auto gap; outOfScope must pre-empt it.
    const output = buildAnswerOutput(
      JSON.stringify({ answer: "Off topic.", confidence: "low", isKnowledgeGap: true, outOfScope: true, gaps: ["cats"] }),
      [],
      "Do cats purr?",
      undefined
    );
    assert.equal(output.gaps, undefined, "outOfScope wins over isKnowledgeGap/empty retrieval");
    assert.ok(output.outOfScope);
  });

  const TWO_SECTIONS: RetrievedSection[] = [
    { sectionId: "s1", documentId: "d1", anchor: "a1", path: "a.md", heading: "A", content: "Alpha.", relevance: 0.4 },
    { sectionId: "s2", documentId: "d2", anchor: "a2", path: "b.md", heading: "B", content: "Beta.", relevance: 0.9 }
  ];

  it("cites only the sections the model says it used, strongest first", () => {
    const output = buildAnswerOutput(
      JSON.stringify({ answer: "Use B.", confidence: "high", isKnowledgeGap: false, usedSectionIds: ["s2"] }),
      TWO_SECTIONS,
      "Which one?",
      undefined
    );
    assert.deepEqual(
      output.citations.map((citation) => citation.sectionId),
      ["s2"],
      "grounds citations to usedSectionIds"
    );
  });

  it("falls back to the whole pool when the model names no valid used sections", () => {
    const output = buildAnswerOutput(
      JSON.stringify({ answer: "Both.", confidence: "high", isKnowledgeGap: false, usedSectionIds: ["nope"] }),
      TWO_SECTIONS,
      "Which one?",
      undefined
    );
    // Invented id ⇒ fall back to the pool, ordered by relevance (s2 before s1).
    assert.deepEqual(
      output.citations.map((citation) => citation.sectionId),
      ["s2", "s1"]
    );
    // An answer attributed only to invented section ids cannot be trusted as
    // grounded: the self-reported "high" is downgraded to low.
    assert.equal(output.confidence, "low");
  });

  it("downgrades unparseable prose output to low confidence but keeps the prose", () => {
    const output = buildAnswerOutput("Deploy by running the script.", SECTIONS, "How do I deploy?", "flow-1");
    assert.equal(output.answer, "Deploy by running the script.");
    assert.equal(output.confidence, "low", "output that broke the JSON contract ships at low, not a quiet medium");
    assert.equal(output.citations.length, 1, "the retrieved pool still attributes the raw answer");
  });

  it("never leaks a broken JSON envelope as the answer", () => {
    // A model that embeds an unescaped quote produces invalid JSON that opens with
    // "{" — the reader must see a safe fallback, not the raw {"action":...} envelope.
    const brokenEnvelope =
      '{"action":"answer","answer":"They said "hi" to me","confidence":"low","isKnowledgeGap":true}';
    const output = buildAnswerOutput(brokenEnvelope, SECTIONS, "What did they say?", "flow-1");
    assert.equal(output.answer, UNPARSEABLE_ANSWER_FALLBACK, "the broken envelope is replaced, not surfaced");
    assert.doesNotMatch(output.answer, /"action"/, "no raw JSON leaks into the answer");
    assert.equal(output.confidence, "low", "an unparseable structured attempt ships distrusted");
  });

  it("emits a followup gap on a confident answer when a search came back empty", () => {
    const output = buildAnswerOutput(
      JSON.stringify({
        answer: "Deploy with the script.",
        confidence: "high",
        isKnowledgeGap: false,
        usedSectionIds: ["doc-1#deploy"],
        followupGaps: ["no staging deploy example"]
      }),
      SECTIONS,
      "How do I deploy?",
      "flow-1",
      new Set(["staging deploy example"])
    );
    assert.equal(output.confidence, "high", "the answer itself stays confident");
    assert.ok(output.gaps && output.gaps.length === 1);
    assert.equal(output.gaps[0].summary, "no staging deploy example");
    assert.equal(output.gaps[0].source, "followup");
    assert.equal(output.gaps[0].confidence, "high");
    assert.deepEqual(output.gaps[0].citedSectionIds, ["doc-1#deploy"]);
  });

  it("drops followup gaps that no empty search backs (ungrounded)", () => {
    const output = buildAnswerOutput(
      JSON.stringify({
        answer: "Deploy with the script.",
        confidence: "high",
        isKnowledgeGap: false,
        usedSectionIds: ["doc-1#deploy"],
        followupGaps: ["a gap the model imagined"]
      }),
      SECTIONS,
      "How do I deploy?",
      "flow-1",
      new Set() // no search came back empty
    );
    assert.equal(output.gaps, undefined, "no grounded followup gaps ⇒ no gaps emitted");
  });
});

describe("forcedSearchQueries", () => {
  it("returns the declared gaps when the model gives up low before searching", () => {
    const queries = forcedSearchQueries(
      JSON.stringify({
        action: "answer",
        answer: "Not covered.",
        confidence: "low",
        isKnowledgeGap: true,
        gaps: ["security certifications", "compliance status"]
      })
    );
    assert.deepEqual(queries, ["security certifications", "compliance status"]);
  });

  it("caps the number of forced queries", () => {
    const queries = forcedSearchQueries(
      JSON.stringify({ answer: "x", confidence: "low", isKnowledgeGap: true, gaps: ["a", "b", "c", "d", "e"] }),
      2
    );
    assert.deepEqual(queries, ["a", "b"]);
  });

  it("does not force a search for a confident answer", () => {
    assert.deepEqual(
      forcedSearchQueries(JSON.stringify({ answer: "Yes.", confidence: "high", isKnowledgeGap: false, gaps: [] })),
      []
    );
  });

  it("does not force a search for an off-topic question", () => {
    assert.deepEqual(
      forcedSearchQueries(
        JSON.stringify({ answer: "Off topic.", confidence: "low", isKnowledgeGap: true, outOfScope: true, gaps: ["cats"] })
      ),
      []
    );
  });

  it("returns nothing when a low answer names no gaps to search for", () => {
    assert.deepEqual(
      forcedSearchQueries(JSON.stringify({ answer: "Maybe.", confidence: "low", isKnowledgeGap: false, gaps: [] })),
      []
    );
  });

  it("returns nothing for an unparseable reply", () => {
    assert.deepEqual(forcedSearchQueries("not json"), []);
  });
});

describe("parseGroundingVerdict", () => {
  it("parses a failed verdict with claims and a revised answer", () => {
    const verdict = parseGroundingVerdict(
      JSON.stringify({ grounded: false, unsupportedClaims: ["SOC 2 status"], revisedAnswer: " Grounded answer. " })
    );
    assert.deepEqual(verdict, {
      grounded: false,
      unsupportedClaims: ["SOC 2 status"],
      revisedAnswer: "Grounded answer."
    });
  });

  it("returns undefined when the reply carries no boolean grounded flag", () => {
    assert.equal(parseGroundingVerdict("not json"), undefined);
    assert.equal(parseGroundingVerdict(JSON.stringify({ answer: "an answer, not a verdict" })), undefined);
  });
});

describe("applyGroundingVerdict", () => {
  const output = buildAnswerOutput(
    JSON.stringify({
      answer: "Deploy the script. We are SOC 2 certified.",
      confidence: "high",
      isKnowledgeGap: false,
      usedSectionIds: ["doc-1#deploy"],
      followupGaps: ["no staging example"]
    }),
    SECTIONS,
    "How do I deploy securely?",
    "flow-1",
    new Set(["staging example"])
  );

  it("returns the output unchanged for a grounded verdict", () => {
    assert.deepEqual(
      applyGroundingVerdict(output, { grounded: true, unsupportedClaims: [] }, "How do I deploy securely?"),
      output
    );
  });

  it("replaces the answer, downgrades to low, and appends the claims as auto gaps", () => {
    const applied = applyGroundingVerdict(
      output,
      { grounded: false, unsupportedClaims: ["SOC 2 compliance status"], revisedAnswer: "Deploy the script." },
      "How do I deploy securely?"
    );
    assert.equal(applied.answer, "Deploy the script.");
    assert.equal(applied.confidence, "low");
    assert.deepEqual(applied.citations, output.citations, "citations still attribute the grounded remainder");
    const summaries = (applied.gaps ?? []).map((gap) => `${gap.source}:${gap.summary}`);
    assert.deepEqual(summaries, ["followup:no staging example", "auto:SOC 2 compliance status"]);
    assert.deepEqual(applied.gaps?.[1].citedSectionIds, ["doc-1#deploy"]);
  });

  it("keeps the drafted answer when the verdict has no revision, but still downgrades", () => {
    const applied = applyGroundingVerdict(
      output,
      { grounded: false, unsupportedClaims: ["SOC 2 compliance status"] },
      "How do I deploy securely?"
    );
    assert.equal(applied.answer, "Deploy the script. We are SOC 2 certified.");
    assert.equal(applied.confidence, "low", "no revision still means the answer ships distrusted");
  });
});

describe("parseJobOutput", () => {
  it("validates summarize_gap output against the job contract", () => {
    const parsed = parseJobOutput(
      job("summarize_gap", {}),
      JSON.stringify({ summary: "s", priority: 2, rationale: "r" })
    );
    assert.deepEqual(parsed, { summary: "s", priority: 2, rationale: "r" });
  });

  it("rejects output that does not match the contract", () => {
    assert.throws(() => parseJobOutput(job("summarize_gap", {}), JSON.stringify({ summary: "s" })));
  });

  it("extracts a JSON object embedded in surrounding prose", () => {
    const parsed = parseJobOutput(
      job("summarize_gap", {}),
      `Sure! Here is the result:\n{"summary":"s","priority":1,"rationale":"r"}\nThanks.`
    );
    assert.deepEqual(parsed, { summary: "s", priority: 1, rationale: "r" });
  });
});
