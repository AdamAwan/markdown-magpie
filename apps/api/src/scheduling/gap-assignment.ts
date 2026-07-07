// Pure geometry + bucketing for the reconciler's phase-1 gap assignment
// (embedding-based coarse pre-clustering). No I/O: the reconciler embeds
// candidate summaries and loads cluster representatives, then calls
// planAssignments to decide which gaps join which cluster. All decisions are
// made against the snapshot passed in — never against mid-pass updates — so
// the outcome is independent of candidate input order.

export interface AssignmentCandidate {
  // Stable identity within the pass (the reconciler uses gapSummaryKey).
  key: string;
  // L2-normalised embedding of the candidate's summary.
  embedding: number[];
}

export interface ClusterRepresentative {
  clusterId: string;
  // L2-normalised representative (centroid) embedding.
  embedding: number[];
}

export interface AssignmentPlan {
  // clusterId -> keys of candidates joining that cluster (key-sorted).
  joins: Map<string, string[]>;
  // Each entry seeds one new cluster: a connected component of candidates that
  // matched no existing cluster. Members are key-sorted; components are ordered
  // by their smallest key.
  seeds: string[][];
}

export function l2Normalise(vector: number[]): number[] {
  let sumSquares = 0;
  for (const value of vector) {
    sumSquares += value * value;
  }
  const magnitude = Math.sqrt(sumSquares);
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    throw new Error("cannot normalise a zero or non-finite vector");
  }
  return vector.map((value) => value / magnitude);
}

// Computed in full (not assuming unit inputs) so slightly-denormalised vectors
// still compare correctly.
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`vector length mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denominator = Math.sqrt(magA) * Math.sqrt(magB);
  return denominator === 0 ? 0 : dot / denominator;
}

// The stored form of a cluster's representative: the normalised mean of its
// distinct member-summary embeddings.
export function normalisedMean(vectors: number[][]): number[] {
  if (vectors.length === 0) {
    throw new Error("cannot average zero vectors");
  }
  const sum = new Array<number>(vectors[0].length).fill(0);
  for (const vector of vectors) {
    if (vector.length !== sum.length) {
      throw new Error(`vector length mismatch: ${vector.length} vs ${sum.length}`);
    }
    for (let i = 0; i < vector.length; i += 1) {
      sum[i] += vector[i];
    }
  }
  return l2Normalise(sum);
}

// Folds new member vectors into a stored centroid: normalise(n·r + Σ v). n·r
// stands in for the true sum of the n prior member vectors — exact when the
// members are identical, and near-exact for the tight clusters the assignment
// threshold produces (every member is within the threshold of the centroid by
// construction). The exact path remains the full recompute the reconciler runs
// when a representative is null.
export function foldIntoCentroid(representative: number[], priorCount: number, additions: number[][]): number[] {
  const sum = representative.map((value) => value * priorCount);
  for (const vector of additions) {
    if (vector.length !== sum.length) {
      throw new Error(`vector length mismatch: ${vector.length} vs ${sum.length}`);
    }
    for (let i = 0; i < vector.length; i += 1) {
      sum[i] += vector[i];
    }
  }
  return l2Normalise(sum);
}

export function planAssignments(
  candidates: AssignmentCandidate[],
  representatives: ClusterRepresentative[],
  threshold: number
): AssignmentPlan {
  // Key-sort once so every downstream structure is input-order independent.
  const ordered = [...candidates].sort((l, r) => l.key.localeCompare(r.key));

  // Stage A: the best existing cluster at or above the threshold wins. Exact
  // ties break toward the earliest representative in the given order — callers
  // pass clusters id-ASC, so ties deterministically prefer the older cluster.
  const joins = new Map<string, string[]>();
  const unmatched: AssignmentCandidate[] = [];
  for (const candidate of ordered) {
    let best: { clusterId: string; similarity: number } | undefined;
    for (const representative of representatives) {
      const similarity = cosineSimilarity(candidate.embedding, representative.embedding);
      if (similarity >= threshold && (!best || similarity > best.similarity)) {
        best = { clusterId: representative.clusterId, similarity };
      }
    }
    if (!best) {
      unmatched.push(candidate);
      continue;
    }
    const bucket = joins.get(best.clusterId);
    if (bucket) {
      bucket.push(candidate.key);
    } else {
      joins.set(best.clusterId, [candidate.key]);
    }
  }

  // Stage B: connected components over the unmatched candidates (edge =
  // pairwise cosine ≥ threshold), via union-find over the sorted list.
  const parent = unmatched.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  for (let i = 0; i < unmatched.length; i += 1) {
    for (let j = i + 1; j < unmatched.length; j += 1) {
      if (cosineSimilarity(unmatched[i].embedding, unmatched[j].embedding) >= threshold) {
        parent[find(i)] = find(j);
      }
    }
  }
  const componentsByRoot = new Map<number, string[]>();
  unmatched.forEach((candidate, index) => {
    const root = find(index);
    const bucket = componentsByRoot.get(root);
    if (bucket) {
      bucket.push(candidate.key);
    } else {
      componentsByRoot.set(root, [candidate.key]);
    }
  });
  const seeds = [...componentsByRoot.values()].sort((l, r) => l[0].localeCompare(r[0]));
  return { joins, seeds };
}
