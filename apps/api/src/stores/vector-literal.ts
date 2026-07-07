// pgvector text-format helpers shared by Postgres stores that read/write
// vector columns. pg returns vector values as their text literal ("[1,2,3]");
// writes send the same literal with a ::vector cast.
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export function parseVectorLiteral(literal: string): number[] {
  const inner = literal.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (inner === "") {
    return [];
  }
  return inner.split(",").map((value) => Number.parseFloat(value));
}
