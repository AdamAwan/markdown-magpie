// Best-effort JSON object extraction from a chat provider's text response.
// Tolerates raw JSON, fenced ```json blocks, and prose surrounding a single
// object. Returns undefined when nothing parses to a JSON *object* — unlike the
// previous version it never returns an array/number/null, matching its name and
// what every caller's downstream guard expects.
export function parseJsonObject(value: string): Record<string, unknown> | undefined {
  for (const candidate of jsonCandidates(value)) {
    const parsed = tryParse(candidate);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }
  return undefined;
}

function* jsonCandidates(value: string): Generator<string> {
  yield value;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(value);
  if (fenced) {
    yield fenced[1];
  }

  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start >= 0 && end > start) {
    yield value.slice(start, end + 1);
  }
}

function tryParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
