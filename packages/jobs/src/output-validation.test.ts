import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  declaredOutputFieldPaths,
  undeclaredFieldPaths,
  undeclaredFieldsMessage,
  undeclaredOutputFieldPolicyFromEnv,
  validateJobOutput
} from "./output-validation.js";
import { JOB_TYPES } from "./types.js";

const draft = { title: "T", targetPath: "kb/t.md", markdown: "# T", rationale: "why" };

describe("undeclaredOutputFieldPolicyFromEnv", () => {
  it("is lenient unless strictness is explicitly switched on", () => {
    assert.equal(undeclaredOutputFieldPolicyFromEnv({}), "strip");
    assert.equal(undeclaredOutputFieldPolicyFromEnv({ MAGPIE_JOB_OUTPUT_STRICT: "false" }), "strip");
    assert.equal(undeclaredOutputFieldPolicyFromEnv({ MAGPIE_JOB_OUTPUT_STRICT: "" }), "strip");
    assert.equal(undeclaredOutputFieldPolicyFromEnv({ MAGPIE_JOB_OUTPUT_STRICT: "true" }), "reject");
  });
});

describe("undeclaredFieldPaths", () => {
  it("reports object-level strips at any depth", () => {
    assert.deepEqual(undeclaredFieldPaths({ a: 1, b: 2 }, { a: 1 }), ["b"]);
    assert.deepEqual(undeclaredFieldPaths({ a: { x: 1, y: 2 } }, { a: { x: 1 } }), ["a.y"]);
    assert.deepEqual(undeclaredFieldPaths({ a: 1 }, { a: 1 }), []);
  });

  it("pairs array elements positionally", () => {
    assert.deepEqual(undeclaredFieldPaths({ a: [{ x: 1 }, { x: 1, y: 2 }] }, { a: [{ x: 1 }, { x: 1 }] }), ["a[1].y"]);
    assert.deepEqual(undeclaredFieldPaths([{ x: 1, y: 2 }], [{ x: 1 }]), ["[0].y"]);
  });

  it("treats a resized array as a leaf rather than guessing the pairing", () => {
    assert.deepEqual(undeclaredFieldPaths({ a: [{ x: 1, y: 2 }, { x: 1 }] }, { a: [{ x: 1 }] }), []);
  });

  it("ignores keys a default added on the parsed side", () => {
    assert.deepEqual(undeclaredFieldPaths({ a: 1 }, { a: 1, added: [] }), []);
  });
});

describe("validateJobOutput", () => {
  it("accepts a fully-declared output under both policies", () => {
    for (const policy of ["strip", "reject"] as const) {
      const result = validateJobOutput("draft_seed_document", { ...draft, uncoveredPoints: ["x"] }, policy);
      assert.deepEqual(result, { ok: true, data: { ...draft, uncoveredPoints: ["x"] }, strippedPaths: [] });
    }
  });

  it("strips an undeclared field and reports it under the production policy", () => {
    const result = validateJobOutput("draft_seed_document", { ...draft, brandNewField: 1 }, "strip");
    assert.deepEqual(result, { ok: true, data: draft, strippedPaths: ["brandNewField"] });
  });

  it("rejects an undeclared field under the strict policy", () => {
    const result = validateJobOutput("draft_seed_document", { ...draft, brandNewField: 1 }, "reject");
    assert.deepEqual(result, { ok: false, reason: "undeclared_fields", undeclaredPaths: ["brandNewField"] });
  });

  it("rejects an undeclared field nested inside an array element", () => {
    const provenance = [{ claim: "c", sources: [{ sourceId: "s", path: "a.md", commit: "abc" }] }];
    const result = validateJobOutput("draft_seed_document", { ...draft, provenance }, "reject");
    assert.deepEqual(result, {
      ok: false,
      reason: "undeclared_fields",
      undeclaredPaths: ["provenance[0].sources[0].commit"]
    });
  });

  it("rejects a field declared only on the other branch of a union", () => {
    // improve_document's improved:false branch deliberately carries no provenance.
    const output = { improved: false, rationale: "nothing to add", provenance: [] };
    assert.deepEqual(validateJobOutput("improve_document", output, "reject"), {
      ok: false,
      reason: "undeclared_fields",
      undeclaredPaths: ["provenance"]
    });
    assert.deepEqual(validateJobOutput("improve_document", output, "strip"), {
      ok: true,
      data: { improved: false, rationale: "nothing to add" },
      strippedPaths: ["provenance"]
    });
  });

  it("reports a contract violation as invalid under both policies", () => {
    for (const policy of ["strip", "reject"] as const) {
      const result = validateJobOutput("draft_seed_document", { title: "T", brandNewField: 1 }, policy);
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.reason, "invalid");
    }
  });

  // Regression: the watcher has always emitted trace.routing.method, but the
  // schema did not declare it, so it never reached the question log.
  it("keeps the answer trace's routing method", () => {
    const output = {
      answer: "a",
      confidence: "high",
      citations: [],
      trace: {
        routing: { mode: "routed", flowId: "f", confidence: "high", method: "embedding" },
        seedSectionCount: 1,
        searches: [],
        poolSectionCount: 1,
        answerForced: false,
        verification: { status: "grounded" }
      }
    };
    assert.deepEqual(validateJobOutput("answer_question", output, "reject"), {
      ok: true,
      data: output,
      strippedPaths: []
    });
  });
});

describe("undeclaredFieldsMessage", () => {
  it("names the job type, the fields and where to declare them", () => {
    const message = undeclaredFieldsMessage("draft_seed_document", ["a", "b.c"]);
    assert.match(message, /draft_seed_document/);
    assert.match(message, /a, b\.c/);
    assert.match(message, /packages\/jobs\/src\/schemas\.ts/);
  });
});

describe("declaredOutputFieldPaths", () => {
  it("lists nested paths through arrays and optionals", () => {
    const { declared } = declaredOutputFieldPaths("draft_markdown_proposal");
    for (const path of ["title", "mapUpdates", "mapUpdates[].observedSha", "provenance[].sources[].lines"]) {
      assert.ok(declared.has(path), `declares ${path}`);
    }
    assert.ok(!declared.has("brandNewField"));
  });

  it("unions the fields of every branch", () => {
    const { declared } = declaredOutputFieldPaths("improve_document");
    assert.ok(declared.has("improved"));
    assert.ok(declared.has("provenance[].claim"));
  });

  it("resolves an object schema for every job type", () => {
    // Guards the introspection itself: if a schema were ever wrapped in a Zod
    // type the walker does not understand, it would silently declare nothing and
    // every prompt-contract check built on it would fail open.
    for (const type of JOB_TYPES) {
      const { declared, open } = declaredOutputFieldPaths(type);
      // refresh_flow_snapshot etc. all declare at least one field.
      assert.ok(declared.size > 0, `${type} declares at least one output field`);
      assert.equal(open.size, 0, `${type} has no open-ended output subtree`);
    }
  });
});
