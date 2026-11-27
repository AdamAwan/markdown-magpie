import { z } from "zod";
import { jobDefinition } from "./catalog.js";
import type { JobType } from "./types.js";

// What to do with a field a job output carries but the job's output schema does
// not declare. Output schemas are `z.object`, so a plain parse silently DROPS
// such a field — the trap that made `mapUpdates`, `uncoveredPoints` and
// `provenance` each "mysteriously disappear" before reaching the API.
//
//  - "strip":  production. Keep the lenient parse (a model emitting one stray
//              field must not fail a paid generation) but report what was
//              dropped so the caller can log it.
//  - "reject": tests, CI and the e2e/eval harnesses. An undeclared field is a
//              hard failure, so a prompt or runner that starts emitting a field
//              nobody declared fails before it ships.
export type UndeclaredOutputFieldPolicy = "strip" | "reject";

// The one place the operator knob is interpreted, shared by the API's config and
// the watcher's composition root: strict only when explicitly switched on, so an
// unset variable can never make production brittle.
export function undeclaredOutputFieldPolicyFromEnv(env: {
  MAGPIE_JOB_OUTPUT_STRICT?: string | undefined;
}): UndeclaredOutputFieldPolicy {
  return env.MAGPIE_JOB_OUTPUT_STRICT === "true" ? "reject" : "strip";
}

export type JobOutputValidation =
  // Valid. `strippedPaths` lists the undeclared fields the parse dropped (always
  // empty under "reject", which fails instead).
  | { ok: true; data: unknown; strippedPaths: string[] }
  // The output violates the contract itself (missing/mistyped declared fields).
  | { ok: false; reason: "invalid"; error: z.ZodError }
  // The output is otherwise valid but carries fields the contract does not
  // declare, and the policy is "reject".
  | { ok: false; reason: "undeclared_fields"; undeclaredPaths: string[] };

// Validates a job output against the job type's output contract — the single
// entry point for every boundary that parses one (the watcher parsing a model's
// reply, the API validating a completion), so they cannot disagree about what
// happens to an undeclared field.
export function validateJobOutput(
  type: JobType,
  output: unknown,
  policy: UndeclaredOutputFieldPolicy
): JobOutputValidation {
  const parsed = jobDefinition(type).outputSchema.safeParse(output);
  if (!parsed.success) {
    return { ok: false, reason: "invalid", error: parsed.error };
  }
  const strippedPaths = undeclaredFieldPaths(output, parsed.data);
  if (strippedPaths.length > 0 && policy === "reject") {
    return { ok: false, reason: "undeclared_fields", undeclaredPaths: strippedPaths };
  }
  return { ok: true, data: parsed.data, strippedPaths };
}

// For an output a runner assembles IN CODE (publication, maintenance, snapshot
// refresh, the reconcile verdicts) rather than parses from a model. Typing the
// argument as the schema's own input makes an undeclared field a COMPILE error
// (excess-property check on the object literal), where a bare
// `schema.parse({...})` would accept anything and silently strip it.
export function buildJobOutput<Schema extends z.ZodType>(schema: Schema, output: z.input<Schema>): z.output<Schema> {
  return schema.parse(output);
}

// The message both boundaries use for an undeclared-field failure, so the fix is
// spelled out wherever it surfaces (a thrown watcher error, a failed job).
export function undeclaredFieldsMessage(type: JobType, undeclaredPaths: readonly string[]): string {
  return (
    `${type} output carries fields the job contract does not declare: ${undeclaredPaths.join(", ")}. ` +
    "Declare them on the job's output schema in packages/jobs/src/schemas.ts (or stop emitting them) — " +
    "an undeclared field is silently stripped in production."
  );
}

// The paths present in `raw` but absent from `kept` after a z.object parse
// stripped unknown keys, e.g. `provenance`, `trace.extra`, `items[2].notes`.
// Walks plain objects and arrays: a Zod array parse preserves length and order,
// so elements pair positionally (an array whose length changed — only possible
// through a transform — is treated as a leaf rather than guessed at).
export function undeclaredFieldPaths(raw: unknown, kept: unknown, prefix = ""): string[] {
  if (Array.isArray(raw) && Array.isArray(kept)) {
    if (raw.length !== kept.length) {
      return [];
    }
    return raw.flatMap((element, index) => undeclaredFieldPaths(element, kept[index], `${prefix}[${index}]`));
  }
  if (!isPlainObject(raw) || !isPlainObject(kept)) {
    return [];
  }
  const paths: string[] = [];
  for (const [key, rawValue] of Object.entries(raw)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in kept)) {
      paths.push(path);
    } else {
      paths.push(...undeclaredFieldPaths(rawValue, kept[key], path));
    }
  }
  return paths;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Every field path a job type's output schema declares, with array elements
// written `[]` (e.g. `provenance[].sources[].lines`). Read off the schema itself,
// so a contract test can ask "does the schema declare what this prompt tells the
// model to return?" without needing a sample that happens to validate. A union
// contributes the fields of every branch. `open` lists paths below which any key
// is acceptable (records and unknown/any values).
export function declaredOutputFieldPaths(type: JobType): { declared: ReadonlySet<string>; open: ReadonlySet<string> } {
  const declared = new Set<string>();
  const open = new Set<string>();
  collectDeclaredPaths(jobDefinition(type).outputSchema, "", declared, open);
  return { declared, open };
}

function collectDeclaredPaths(schema: z.core.$ZodType, prefix: string, declared: Set<string>, open: Set<string>): void {
  if (schema instanceof z.ZodObject) {
    for (const [key, value] of Object.entries(schema.shape)) {
      const path = prefix ? `${prefix}.${key}` : key;
      declared.add(path);
      collectDeclaredPaths(value, path, declared, open);
    }
    return;
  }
  if (schema instanceof z.ZodArray) {
    collectDeclaredPaths(schema.element, `${prefix}[]`, declared, open);
    return;
  }
  if (schema instanceof z.ZodUnion) {
    for (const option of schema.options) {
      collectDeclaredPaths(option, prefix, declared, open);
    }
    return;
  }
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault) {
    collectDeclaredPaths(schema.unwrap(), prefix, declared, open);
    return;
  }
  if (schema instanceof z.ZodRecord || schema instanceof z.ZodUnknown || schema instanceof z.ZodAny) {
    open.add(prefix);
  }
}
