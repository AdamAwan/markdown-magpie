// The intersection of two file-sets, de-duplicated and in `a`'s order. Two changes
// overlap (and so must be reconciled rather than raised as rival PRs) exactly when
// this is non-empty.
export function sharedTargets(a: string[], b: string[]): string[] {
  const inB = new Set(b);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of a) {
    if (inB.has(path) && !seen.has(path)) {
      seen.add(path);
      out.push(path);
    }
  }
  return out;
}
