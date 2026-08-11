import { z } from "zod";

// The mapping the operator confirms. Deliberately the same shape the mapping job
// returns: the operator is editing the model's proposal, not a different object,
// so a hand-mapped sheet and a model-mapped one take identical paths.
const sheetMappingSchema = z.object({
  sheetIndex: z.number().int().min(0),
  role: z.enum(["questions", "ignore"]),
  headerRow: z.number().int().min(0).nullable(),
  questionColumn: z.number().int().min(0).nullable(),
  answerColumn: z.number().int().min(0).nullable(),
  responseTypeColumn: z.number().int().min(0).nullable(),
  sectionHeadingColumn: z.number().int().min(0).nullable(),
  confidence: z.enum(["high", "medium", "low"]),
  reason: z.string().max(500)
});

export const confirmImportSchema = z.object({
  sheets: z
    .array(
      z.object({
        sheetIndex: z.number().int().min(0),
        include: z.boolean(),
        mapping: sheetMappingSchema
      })
    )
    .min(1)
    .max(20),
  // Rows the operator promoted out of the unclassified list, as "sheet:row".
  // Bounded by the questionnaire's own 500-question cap.
  promoted: z
    .array(z.string().regex(/^\d+:\d+$/))
    .max(500)
    .optional()
});
