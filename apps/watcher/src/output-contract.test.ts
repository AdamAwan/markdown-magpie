import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AI_JOB_TYPES, declaredOutputFieldPaths, type JobType } from "@magpie/jobs";
import { JOB_PROMPTS } from "./job-prompts.js";

// The contract test for the "undeclared output field" trap.
//
// A model-driven job's output is whatever its catalog prompt tells the model to
// return; the watcher then parses that reply against the job's output schema,
// and a z.object parse DROPS any field the schema does not declare. So the bug
// is always the same shape: someone adds a field to a prompt (`mapUpdates`,
// `uncoveredPoints`, `provenance` — all three shipped this way) and forgets the
// schema. These tests read the fields straight off each prompt and assert the
// schema declares every one, so that drift fails here instead of in production.
//
// The fields come from three places in a PromptDefinition:
//   - `outputShape`, the prompt's own one-line summary of its return shape;
//   - the trailing "Return JSON:" example block in `instructions`;
//   - flat inline JSON examples in the rules ('return {"improved": false, ...}').

// Provider jobs whose output is NOT parsed from a prompt-shaped model reply, and
// why. Every other provider job must have a catalog prompt in JOB_PROMPTS.
const NOT_PROMPT_SHAPED: Partial<Record<JobType, string>> = {
  answer_question: "assembled in code as AnswerOutput, which is the schema's own parsed type",
  answer_question_batch: "shares the answer_question handler and contract",
  reconcile_gap_clusters: "assembled in code through buildJobOutput(reconcileGapClustersOutputSchema, …)",
  suggest_consolidation: "runs on the generic job envelope, whose prompt names no output fields"
};

// Prompts that describe their output in prose only (no trailing example block).
// Listed so that a NEW prompt without an example is a conscious choice, and so a
// change to the block's wording cannot silently turn the example check off.
const NO_EXAMPLE_BLOCK: readonly JobType[] = ["verify_imported_answer", "map_questionnaire_columns"];

const promptedTypes = Object.keys(JOB_PROMPTS).filter((type): type is JobType => type in JOB_PROMPTS);

// `{ items: [{ title, targetPath? }], rationale, changeset[], mapUpdates? }` ->
// ["items", "items[].title", "items[].targetPath", "rationale", "changeset", "mapUpdates"].
function outputShapePaths(shape: string, prefix = ""): string[] {
  const body = shape.trim().replace(/^\{/, "").replace(/\}$/, "");
  const paths: string[] = [];
  for (const part of splitTopLevel(body)) {
    const match = /^([A-Za-z_]\w*)\??(\[\])?\s*(?::\s*([\s\S]*))?$/.exec(part.trim());
    assert.ok(match, `unreadable outputShape entry: "${part.trim()}" in "${shape}"`);
    const [, name, , nested] = match;
    const path = prefix ? `${prefix}.${name}` : name;
    paths.push(path);
    const element = /^\[\s*(\{[\s\S]*\})\s*\]$/.exec(nested?.trim() ?? "");
    if (element?.[1]) {
      paths.push(...outputShapePaths(element[1], `${path}[]`));
    } else if (nested?.trim().startsWith("{")) {
      paths.push(...outputShapePaths(nested, path));
    }
  }
  return paths;
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "{" || char === "[") depth += 1;
    if (char === "}" || char === "]") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

// Every key path in a parsed JSON example, arrays written `[]`.
function jsonKeyPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((element) => jsonKeyPaths(element, `${prefix}[]`));
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [path, ...jsonKeyPaths(child, path)];
  });
}

// The trailing `Return JSON:` / `Return JSON only:` example, when a prompt has one.
function exampleBlock(instructions: string): string | undefined {
  return /Return JSON(?: only)?:\n(\{[\s\S]*\})\s*$/.exec(instructions)?.[1];
}

// Flat single-line JSON objects quoted in the rules, e.g.
// `return {"duplicate": false, "rationale": "...", "changeset": []}`.
function inlineExamples(instructions: string): unknown[] {
  const examples: unknown[] = [];
  // The trailing example block is read whole (with its nesting) by its own
  // test; scanning it here would lift its inner objects out of context.
  const rules = instructions.replace(exampleBlock(instructions) ?? "", "");
  for (const candidate of rules.match(/\{"[^\n{}]*\}/g) ?? []) {
    try {
      examples.push(JSON.parse(candidate));
    } catch {
      // Not literal JSON (a placeholder such as true|false) — nothing to read.
    }
  }
  return examples;
}

function assertDeclared(type: JobType, paths: readonly string[], origin: string): void {
  const { declared, open } = declaredOutputFieldPaths(type);
  const undeclared = [...new Set(paths)].filter(
    (path) => !declared.has(path) && ![...open].some((prefix) => path.startsWith(prefix))
  );
  assert.deepEqual(
    undeclared,
    [],
    `${type}: the prompt's ${origin} tells the model to return ${undeclared.join(", ")}, ` +
      `but ${type}'s output schema (packages/jobs/src/schemas.ts) does not declare ` +
      `${undeclared.length === 1 ? "it" : "them"} — the watcher would silently strip ` +
      `${undeclared.length === 1 ? "it" : "them"} from every completion. Declare the field(s) on the schema.`
  );
}

describe("job output contract: every field a prompt asks for is declared on the job's output schema", () => {
  it("covers every provider job type, by prompt or by a stated exemption", () => {
    const uncovered = AI_JOB_TYPES.filter((type) => !JOB_PROMPTS[type] && !NOT_PROMPT_SHAPED[type]);
    assert.deepEqual(
      uncovered,
      [],
      "a provider job with no catalog prompt needs an entry in NOT_PROMPT_SHAPED saying where its output comes from"
    );
    const both = promptedTypes.filter((type) => NOT_PROMPT_SHAPED[type]);
    assert.deepEqual(both, [], "a job with a catalog prompt must not also be exempted");
  });

  for (const type of promptedTypes) {
    const prompt = JOB_PROMPTS[type];
    if (!prompt) continue;

    it(`${type}: outputShape fields are declared`, () => {
      const paths = outputShapePaths(prompt.outputShape);
      assert.ok(paths.length > 0, `${type}: outputShape "${prompt.outputShape}" names no fields`);
      assertDeclared(type, paths, `outputShape (${prompt.outputShape})`);
    });

    it(`${type}: "Return JSON" example fields are declared`, () => {
      const block = exampleBlock(prompt.instructions);
      if (NO_EXAMPLE_BLOCK.includes(type)) {
        assert.equal(block, undefined, `${type} now has an example block — remove it from NO_EXAMPLE_BLOCK`);
        return;
      }
      assert.ok(block, `${type}: no trailing "Return JSON:" example block found in the prompt`);
      // A malformed example is a prompt bug in its own right — fail, don't skip.
      const paths = jsonKeyPaths(JSON.parse(block));
      assert.ok(paths.length > 0);
      assertDeclared(type, paths, '"Return JSON" example');
    });

    it(`${type}: inline JSON examples in the rules use declared fields`, () => {
      assertDeclared(
        type,
        inlineExamples(prompt.instructions).flatMap((example) => jsonKeyPaths(example)),
        "inline example"
      );
    });
  }
});

describe("job output contract: the readers above see what they should", () => {
  it("reads nested and array entries out of an outputShape", () => {
    assert.deepEqual(outputShapePaths("{ items: [{ title, targetPath?, coverage[] }], rationale, mapUpdates? }"), [
      "items",
      "items[].title",
      "items[].targetPath",
      "items[].coverage",
      "rationale",
      "mapUpdates"
    ]);
  });

  it("reads key paths out of a JSON example", () => {
    assert.deepEqual(jsonKeyPaths({ a: 1, b: [{ c: [{ d: "x" }] }] }), ["a", "b", "b[].c", "b[].c[].d"]);
  });

  it("fails with the fix spelled out when a prompt asks for an undeclared field", () => {
    assert.throws(
      () => assertDeclared("summarize_gap", ["summary", "confidenceNotes"], "outputShape"),
      /summarize_gap: the prompt's outputShape tells the model to return confidenceNotes[\s\S]*Declare the field/
    );
  });
});
