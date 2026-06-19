export interface MergeCandidateCluster {
  id: string;
  createdAt: string; // ISO
}

// The oldest PR survives a merge. "Oldest" = earliest cluster createdAt; ties are
// broken by the lowest numeric id so the choice is fully deterministic.
export function selectSurvivingClusterOnMerge(clusters: MergeCandidateCluster[]): string {
  if (clusters.length === 0) {
    throw new Error("selectSurvivingClusterOnMerge requires at least one cluster");
  }
  return [...clusters].sort((l, r) => {
    if (l.createdAt !== r.createdAt) {
      return l.createdAt < r.createdAt ? -1 : 1;
    }
    return compareNumericIds(l.id, r.id);
  })[0].id;
}

export interface SplitChild {
  key: string;
  gapIds: string[];
}

// The largest child keeps the original cluster/PR. Ties (equal member count) are
// broken by the child whose lowest gap id is smallest, using stable member
// ordering.
export function selectRetainingChildOnSplit(children: SplitChild[]): string {
  if (children.length === 0) {
    throw new Error("selectRetainingChildOnSplit requires at least one child");
  }
  return [...children].sort((l, r) => {
    if (l.gapIds.length !== r.gapIds.length) {
      return r.gapIds.length - l.gapIds.length; // larger first
    }
    return compareNumericIds(lowestId(l.gapIds), lowestId(r.gapIds));
  })[0].key;
}

function lowestId(ids: string[]): string {
  return [...ids].sort(compareNumericIds)[0];
}

function compareNumericIds(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) {
    return na - nb;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
