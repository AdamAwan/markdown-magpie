import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
// FlowSnapshot and its parts are canonical domain shapes shared with the web
// console (which reads them back over /snapshots), so they live in @magpie/core
// rather than being declared here and mirrored by hand.
import type { FlowSnapshot, GapCandidate, SnapshotProposal, SnapshotPullRequest } from "@magpie/core";

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

// A flow token addresses exactly one directory directly under the snapshot root,
// so it must stay a single path segment. `read()` takes its flowId straight from
// an untrusted `GET /api/snapshots/:flowId` route param, so reject any separator,
// parent-directory reference, or NUL *before* the token is ever joined onto the
// root — mirroring the assertWithinRoot/resolveLocalPathWithinRoot confinement
// guards used elsewhere. A traversal attempt never reaches the filesystem.
function isSafeFlowToken(token: string): boolean {
  return token.length > 0 && !token.includes("..") && !/[/\\\0]/.test(token);
}

// Writes one directory per flow under the snapshot root, splitting the payload
// into gaps.json / proposals.json / pull-requests.json / meta.json so each is
// independently readable on disk. read() returns undefined until the first write.
export class FileSnapshotStore implements SnapshotStore {
  constructor(private readonly root: string) {}

  // Returns the confined snapshot directory for a flow, or undefined when the
  // flow token would escape the root. Callers treat undefined as "no such
  // snapshot" (read) or a hard error (write) rather than touching the filesystem.
  private dir(flowId: string | undefined): string | undefined {
    const token = flowToken(flowId);
    if (!isSafeFlowToken(token)) {
      return undefined;
    }
    return path.join(this.root, token);
  }

  async read(flowId: string | undefined): Promise<FlowSnapshot | undefined> {
    const dir = this.dir(flowId);
    if (dir === undefined) {
      // Unsafe/traversal flowId — reject before any filesystem access. The route
      // surfaces this as a 404, matching an unknown flow.
      return undefined;
    }
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
    if (dir === undefined) {
      // Writes come from trusted flow config, so an unsafe token is a bug worth
      // surfacing rather than silently writing outside the snapshot root.
      throw new Error(`unsafe snapshot flow id: ${JSON.stringify(snapshot.flowId)}`);
    }
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
