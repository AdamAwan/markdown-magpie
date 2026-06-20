import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GapCandidate, Proposal } from "@magpie/core";

// A flow's proposal as captured in a snapshot — just the fields the processor and
// a human reviewer need, not the full markdown body.
export interface SnapshotProposal {
  id: string;
  title?: string;
  status: Proposal["status"];
  gapClusterId?: string;
  pullRequestUrl?: string;
}

// The polled state of one of this flow's open pull requests. `etag` and
// `checkedAt` back the cache: a later refresh can issue a conditional request and
// keep the prior state on a 304 instead of re-reading the whole PR.
export interface SnapshotPullRequest {
  proposalId: string;
  url: string;
  merged: boolean;
  state: "open" | "closed" | "unknown";
  etag?: string;
  checkedAt: string;
}

// Everything the fetch job downloads for one flow: the inputs the reconciler would
// otherwise gather live (gaps, proposals) plus the externally-polled PR state.
export interface FlowSnapshot {
  flowId?: string;
  takenAt: string;
  catalogRevision: number;
  gaps: GapCandidate[];
  proposals: SnapshotProposal[];
  pullRequests: SnapshotPullRequest[];
}

// The on-disk location the fetch job writes and the processor reads. There is no
// Postgres variant — the whole point is an inspectable "downloaded data" location.
export interface SnapshotStore {
  read(flowId: string | undefined): Promise<FlowSnapshot | undefined>;
  write(snapshot: FlowSnapshot): Promise<void>;
  reset(): Promise<void>;
}

// The un-routed/default flow uses the same "default" token as its scheduled-task
// key, so the snapshot directory lines up with the task that writes it.
function flowToken(flowId: string | undefined): string {
  return flowId ?? "default";
}

// Writes one directory per flow under the snapshot root, splitting the payload
// into gaps.json / proposals.json / pull-requests.json / meta.json so each is
// independently readable on disk. read() returns undefined until the first write.
export class FileSnapshotStore implements SnapshotStore {
  constructor(private readonly root: string) {}

  private dir(flowId: string | undefined): string {
    return path.join(this.root, flowToken(flowId));
  }

  async read(flowId: string | undefined): Promise<FlowSnapshot | undefined> {
    const dir = this.dir(flowId);
    try {
      const [meta, gaps, proposals, pullRequests] = await Promise.all([
        readFile(path.join(dir, "meta.json"), "utf8"),
        readFile(path.join(dir, "gaps.json"), "utf8"),
        readFile(path.join(dir, "proposals.json"), "utf8"),
        readFile(path.join(dir, "pull-requests.json"), "utf8")
      ]);
      // Reconstruct the shape explicitly: JSON.stringify omits flowId when it is
      // undefined (the default flow), so spreading the parsed meta would drop the
      // key. Setting it from parsedMeta keeps flowId always present.
      const parsedMeta = JSON.parse(meta) as { flowId?: string; takenAt: string; catalogRevision: number };
      return {
        flowId: parsedMeta.flowId,
        takenAt: parsedMeta.takenAt,
        catalogRevision: parsedMeta.catalogRevision,
        gaps: JSON.parse(gaps) as GapCandidate[],
        proposals: JSON.parse(proposals) as SnapshotProposal[],
        pullRequests: JSON.parse(pullRequests) as SnapshotPullRequest[]
      };
    } catch {
      // No snapshot yet (or a partial/corrupt one) — the caller falls back to live.
      return undefined;
    }
  }

  async write(snapshot: FlowSnapshot): Promise<void> {
    const dir = this.dir(snapshot.flowId);
    await mkdir(dir, { recursive: true });
    const meta = { flowId: snapshot.flowId, takenAt: snapshot.takenAt, catalogRevision: snapshot.catalogRevision };
    await Promise.all([
      writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2)),
      writeFile(path.join(dir, "gaps.json"), JSON.stringify(snapshot.gaps, null, 2)),
      writeFile(path.join(dir, "proposals.json"), JSON.stringify(snapshot.proposals, null, 2)),
      writeFile(path.join(dir, "pull-requests.json"), JSON.stringify(snapshot.pullRequests, null, 2))
    ]);
  }

  async reset(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

export class InMemorySnapshotStore implements SnapshotStore {
  private readonly snapshots = new Map<string, FlowSnapshot>();

  async read(flowId: string | undefined): Promise<FlowSnapshot | undefined> {
    return this.snapshots.get(flowToken(flowId));
  }

  async write(snapshot: FlowSnapshot): Promise<void> {
    this.snapshots.set(flowToken(snapshot.flowId), snapshot);
  }

  async reset(): Promise<void> {
    this.snapshots.clear();
  }
}
