import pg from "pg";
import type {
  CreateClusterInput,
  GapClusterMembershipRecord,
  GapClusterRecord,
  GapClusterStore,
  PublicationActionRecord,
  UpdateClusterInput
} from "./gap-cluster-store.js";
import { chunk, valuesClause } from "./sql-bulk.js";

// gap_cluster_memberships inserts bind 3 params/row (cluster_id, gap_id,
// rationale); keep the chunk well under Postgres' 65535-param cap.
const MEMBERSHIP_INSERT_CHUNK = 1000;

interface ClusterRow {
  id: string;
  flow_id: string | null;
  title: string;
  rationale: string | null;
  status: "active" | "frozen";
  parent_cluster_id: string | null;
  reconciliation_revision: string;
  created_at: Date;
  updated_at: Date;
}

interface MembershipRow {
  id: string;
  cluster_id: string;
  gap_id: string;
  active: boolean;
  rationale: string | null;
  created_at: Date;
}

interface ActionRow {
  id: string;
  proposal_id: string;
  kind: "publish" | "supersede";
  status: "pending" | "done" | "failed";
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export class PostgresGapClusterStore implements GapClusterStore {
  constructor(private readonly pool: pg.Pool) {}

  async listActiveClusters(): Promise<GapClusterRecord[]> {
    const result = await this.pool.query<ClusterRow>(
      "SELECT * FROM gap_clusters WHERE status = 'active' ORDER BY id ASC"
    );
    return result.rows.map(mapCluster);
  }

  async listActiveClustersForFlow(
    flowId: string | undefined,
    limit?: number
  ): Promise<GapClusterRecord[]> {
    // Scope to one flow in SQL (coalescing NULL flow_id to '' so the un-routed
    // flow matches), and bound the scan when a limit is given.
    const base = "SELECT * FROM gap_clusters WHERE status = 'active' AND coalesce(flow_id, '') = $1 ORDER BY id ASC";
    const result =
      limit === undefined
        ? await this.pool.query<ClusterRow>(base, [flowId ?? ""])
        : await this.pool.query<ClusterRow>(`${base} LIMIT $2`, [flowId ?? "", limit]);
    return result.rows.map(mapCluster);
  }

  async getCluster(id: string): Promise<GapClusterRecord | undefined> {
    const result = await this.pool.query<ClusterRow>("SELECT * FROM gap_clusters WHERE id = $1", [id]);
    return result.rows[0] ? mapCluster(result.rows[0]) : undefined;
  }

  async createCluster(input: CreateClusterInput): Promise<GapClusterRecord> {
    const result = await this.pool.query<ClusterRow>(
      `
        INSERT INTO gap_clusters (flow_id, title, rationale, parent_cluster_id, reconciliation_revision)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `,
      [input.flowId ?? null, input.title, input.rationale ?? null, input.parentClusterId ?? null, input.revision]
    );
    return mapCluster(result.rows[0]);
  }

  async updateCluster(id: string, patch: UpdateClusterInput): Promise<GapClusterRecord | undefined> {
    const result = await this.pool.query<ClusterRow>(
      `
        UPDATE gap_clusters
        SET title = COALESCE($2, title),
            rationale = COALESCE($3, rationale),
            reconciliation_revision = COALESCE($4, reconciliation_revision),
            updated_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [id, patch.title ?? null, patch.rationale ?? null, patch.revision ?? null]
    );
    return result.rows[0] ? mapCluster(result.rows[0]) : undefined;
  }

  async freezeCluster(id: string): Promise<void> {
    await this.pool.query("UPDATE gap_clusters SET status = 'frozen', updated_at = now() WHERE id = $1", [id]);
  }

  async listActiveMemberships(): Promise<GapClusterMembershipRecord[]> {
    const result = await this.pool.query<MembershipRow>(
      "SELECT * FROM gap_cluster_memberships WHERE active ORDER BY id ASC"
    );
    return result.rows.map(mapMembership);
  }

  async listActiveMembershipsForFlow(flowId: string | undefined): Promise<GapClusterMembershipRecord[]> {
    // Join to the owning cluster so the flow filter lives in SQL; the reconciler
    // only loads this flow's assigned-gap set instead of every flow's.
    const result = await this.pool.query<MembershipRow>(
      `
        SELECT m.*
        FROM gap_cluster_memberships m
        JOIN gap_clusters c ON c.id = m.cluster_id
        WHERE m.active AND coalesce(c.flow_id, '') = $1
        ORDER BY m.id ASC
      `,
      [flowId ?? ""]
    );
    return result.rows.map(mapMembership);
  }

  async listMembershipsForCluster(clusterId: string): Promise<GapClusterMembershipRecord[]> {
    const result = await this.pool.query<MembershipRow>(
      "SELECT * FROM gap_cluster_memberships WHERE active AND cluster_id = $1 ORDER BY id ASC",
      [clusterId]
    );
    return result.rows.map(mapMembership);
  }

  async assignGapToCluster(clusterId: string, gapId: string, rationale?: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE gap_cluster_memberships SET active = false WHERE active AND gap_id = $1", [gapId]);
      await client.query(
        "INSERT INTO gap_cluster_memberships (cluster_id, gap_id, rationale) VALUES ($1, $2, $3)",
        [clusterId, gapId, rationale ?? null]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async assignGapsToCluster(clusterId: string, gapIds: string[], rationale?: string): Promise<void> {
    if (gapIds.length === 0) {
      return;
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Deactivate any prior active membership of these gaps in one statement,
      // then insert the new memberships in a handful of multi-row INSERTs rather
      // than one round-trip per gap.
      await client.query(
        "UPDATE gap_cluster_memberships SET active = false WHERE active AND gap_id = ANY($1::bigint[])",
        [gapIds]
      );
      for (const batch of chunk(gapIds, MEMBERSHIP_INSERT_CHUNK)) {
        await client.query(
          `
            INSERT INTO gap_cluster_memberships (cluster_id, gap_id, rationale)
            VALUES ${valuesClause(batch.length, 3)}
          `,
          batch.flatMap((gapId) => [clusterId, gapId, rationale ?? null])
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async deactivateClusterMemberships(clusterId: string): Promise<void> {
    await this.pool.query("UPDATE gap_cluster_memberships SET active = false WHERE active AND cluster_id = $1", [
      clusterId
    ]);
  }

  async deactivateMembershipsForGaps(gapIds: string[]): Promise<void> {
    if (gapIds.length === 0) {
      return;
    }
    await this.pool.query(
      "UPDATE gap_cluster_memberships SET active = false WHERE active AND gap_id = ANY($1::bigint[])",
      [gapIds]
    );
  }

  async getProcessedRevision(flowId?: string): Promise<number> {
    const result = await this.pool.query<{ processed_revision: string }>(
      "SELECT processed_revision FROM gap_reconciler_state WHERE flow_id = $1",
      [flowId ?? ""]
    );
    return result.rows[0] ? Number(result.rows[0].processed_revision) : 0;
  }

  async setProcessedRevision(flowId: string | undefined, revision: number, lastRunAt: string): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO gap_reconciler_state (flow_id, processed_revision, last_run_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (flow_id) DO UPDATE
          SET processed_revision = EXCLUDED.processed_revision,
              last_run_at = EXCLUDED.last_run_at
      `,
      [flowId ?? "", revision, lastRunAt]
    );
  }

  async enqueuePublicationAction(
    proposalId: string,
    kind: "publish" | "supersede"
  ): Promise<PublicationActionRecord> {
    const result = await this.pool.query<ActionRow>(
      "INSERT INTO gap_publication_actions (proposal_id, kind) VALUES ($1, $2) RETURNING *",
      [proposalId, kind]
    );
    return mapAction(result.rows[0]);
  }

  async listPendingPublicationActions(): Promise<PublicationActionRecord[]> {
    const result = await this.pool.query<ActionRow>(
      "SELECT * FROM gap_publication_actions WHERE status IN ('pending', 'failed') ORDER BY created_at ASC"
    );
    return result.rows.map(mapAction);
  }

  async markPublicationActionDone(id: string): Promise<void> {
    await this.pool.query("UPDATE gap_publication_actions SET status = 'done', updated_at = now() WHERE id = $1", [
      id
    ]);
  }

  async markPublicationActionFailed(id: string, error: string): Promise<void> {
    await this.pool.query(
      `
        UPDATE gap_publication_actions
        SET status = 'failed', attempts = attempts + 1, last_error = $2, updated_at = now()
        WHERE id = $1
      `,
      [id, error]
    );
  }

  async reset(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM gap_publication_actions");
      await client.query("DELETE FROM gap_cluster_memberships");
      await client.query("UPDATE proposals SET gap_cluster_id = NULL WHERE gap_cluster_id IS NOT NULL");
      await client.query("DELETE FROM gap_clusters");
      await client.query("DELETE FROM gap_reconciler_state");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function mapCluster(row: ClusterRow): GapClusterRecord {
  return {
    id: row.id,
    flowId: row.flow_id ?? undefined,
    title: row.title,
    rationale: row.rationale ?? undefined,
    status: row.status,
    parentClusterId: row.parent_cluster_id ?? undefined,
    reconciliationRevision: Number(row.reconciliation_revision),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function mapMembership(row: MembershipRow): GapClusterMembershipRecord {
  return {
    id: row.id,
    clusterId: row.cluster_id,
    gapId: row.gap_id,
    active: row.active,
    rationale: row.rationale ?? undefined,
    createdAt: row.created_at.toISOString()
  };
}

function mapAction(row: ActionRow): PublicationActionRecord {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    kind: row.kind,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}
