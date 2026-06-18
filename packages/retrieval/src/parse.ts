import type { Confidence } from "@magpie/core";

// Best-effort JSON object extraction from a model's text response: tolerates raw
// JSON, fenced ```json blocks, and a single object embedded in prose. Shared by
// the answer and routing paths.
export function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(value);
    if (fenced) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        return undefined;
      }
    }

    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(value.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
  }

  return undefined;
}

export function normalizeConfidence(value: unknown): Confidence {
  return value === "high" || value === "medium" || value === "low" ? value : "low";
}
