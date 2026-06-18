// Helpers for building chunked multi-row INSERTs, so a re-index writes its
// documents/sections in a handful of round-trips instead of one query per row
// inside the transaction. Kept pure (no pg) so the placeholder arithmetic — the
// easy thing to get wrong — can be unit-tested without a database.

// Split items into batches of at most `size`. Postgres caps a statement at
// 65535 bind parameters, so callers pick a size that keeps rows*columns under it.
export function chunk<T>(items: T[], size: number): T[][] {
  if (size < 1) {
    throw new Error("chunk size must be >= 1");
  }
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

// Build the "($1, $2), ($3, $4), ..." fragment for a multi-row VALUES clause,
// numbering bind parameters from 1. `trailing` appends per-row SQL literals that
// are not bound parameters (e.g. ["now()"] for an updated_at column).
export function valuesClause(rowCount: number, columnsPerRow: number, trailing: string[] = []): string {
  const groups: string[] = [];
  let param = 1;
  for (let row = 0; row < rowCount; row++) {
    const cols: string[] = [];
    for (let col = 0; col < columnsPerRow; col++) {
      cols.push(`$${param++}`);
    }
    cols.push(...trailing);
    groups.push(`(${cols.join(", ")})`);
  }
  return groups.join(", ");
}
