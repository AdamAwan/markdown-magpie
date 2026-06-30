import { z } from "zod";

// Trims first, then requires a non-empty result, so a whitespace-only flowId is
// still rejected (preserving the route's prior manual `.trim()` + required check).
export const reconcileBodySchema = z.object({
  flowId: z.string().trim().min(1)
});

// The body is optional; targetPath/destinationId override the flow's defaults when
// supplied. Both are optional strings — a present-but-wrong-typed value is a 400
// rather than being silently coerced to undefined.
export const draftFromClusterBodySchema = z.object({
  targetPath: z.string().optional(),
  destinationId: z.string().optional()
});
