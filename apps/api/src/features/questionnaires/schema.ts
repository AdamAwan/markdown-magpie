import { z } from "zod";

// One question per array entry; the console splits pasted text client-side.
// The 500 cap is a sanity bound, not a product limit — the drip means size only
// affects duration, but an unbounded body invites accidental megabyte pastes.
// Each entry also becomes one DB row + one embedding, so bound the per-question
// length (not just the array count) to keep a single giant paste from being
// persisted/embedded (#293). 4000 chars is generous for a real question.
// `direction` is the optional free-text steer for how these questions should be
// READ ("where ambiguous, assume the company and not the product"). Set at
// creation and immutable — answering starts on create, so an edit would leave
// one questionnaire holding answers written under two different directions.
// Trimmed; a blank value normalises to absent in the service so "" and NULL are
// never distinguishable downstream (the fast-path comparison depends on it).
// A question arrives either bare (the original paste flow) or paired with the
// answer previously given to it — ingesting a completed questionnaire
// (docs/superpowers/specs/2026-08-11-questionnaire-ingestion-design.md). The
// imported answer is bounded more generously than the question, because real
// questionnaire answers run to paragraphs, but still bounded: each entry is one
// DB row, and an unbounded body invites accidental megabyte pastes.
const questionEntrySchema = z.union([
  z.string().max(4000),
  z.object({
    question: z.string().max(4000),
    importedAnswer: z.string().trim().max(20000).optional()
  })
]);

export const createQuestionnaireSchema = z.object({
  name: z.string().trim().min(1).max(500),
  flowId: z.string().min(1).max(200),
  questions: z.array(questionEntrySchema).min(1).max(500),
  direction: z.string().trim().max(2000).optional(),
  // Where an imported batch came from (e.g. the source file's name). Its
  // presence is what switches the questionnaire onto the adjudication path, so
  // an ordinary questionnaire simply omits it. Trimmed; blank normalises to
  // absent in the service, the same discipline `direction` follows.
  importOrigin: z.string().trim().max(500).optional()
});

// Which wording the reviewer is approving into the match corpus. Optional, so a
// caller that sends no body at all keeps the pre-ingestion behaviour.
export const approveItemSchema = z.object({
  use: z.enum(["imported", "magpie"]).optional()
});

export const exportQuerySchema = z.object({
  format: z.enum(["md", "csv"]).default("md")
});
