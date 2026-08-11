import type { Questionnaire } from "@magpie/core";

// Ingesting completed questionnaires
// (docs/superpowers/specs/2026-08-11-questionnaire-ingestion-design.md).
//
// An imported questionnaire is one created from a completed questionnaire whose
// previously-given answers are being adjudicated rather than trusted.
// `importOrigin`'s presence is the single switch: a questionnaire created the
// ordinary way leaves it absent and behaves byte-for-byte as it did before
// ingestion existed (spec D1).
//
// Deliberately keyed off the PARENT row, not off whether individual items happen
// to carry an imported answer: a batch pasted with some answers blank is still an
// imported questionnaire, and must not half-take the ordinary path.
export function isImported(questionnaire: Pick<Questionnaire, "importOrigin">): boolean {
  return typeof questionnaire.importOrigin === "string" && questionnaire.importOrigin.length > 0;
}
