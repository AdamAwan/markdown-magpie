import { randomUUID } from "node:crypto";
import pg from "pg";
import type { SeedPlan, SeedPlanItem, SeedPlanStatus } from "@magpie/core";
import type { NewSeedPlan, SeedPlanItemPatch, SeedPlanStore } from "./seed-plan-store.js";

interface SeedPlanRow {
  id: string;
  flow_id: string;
  status: SeedPlanStatus;
  origin: "manual" | "auto";
  charter: string | null;
  persona: string | null;
  charter_proposed: boolean;
  persona_proposed: boolean;
  items: SeedPlanItem[];
  rationale: string;
  notes: string | null;
  outline_job_id: string;
  source_hash: string;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: SeedPlanRow): SeedPlan {
  return {
    id: row.id,
    flowId: row.flow_id,
    status: row.status,
    origin: row.origin,
    ...(row.charter !== null ? { charter: row.charter } : {}),
    ...(row.persona !== null ? { persona: row.persona } : {}),
    charterProposed: row.charter_proposed,
    personaProposed: row.persona_proposed,
    items: row.items,
    rationale: row.rationale,
    ...(row.notes !== null ? { notes: row.notes } : {}),
    outlineJobId: row.outline_job_id,
    sourceHash: row.source_hash,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function patchItem(item: SeedPlanItem, patch: SeedPlanItemPatch): SeedPlanItem {
  return {
    ...item,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.targetPath !== undefined ? { targetPath: patch.targetPath } : {}),
    ...(patch.coverage !== undefined ? { coverage: [...patch.coverage] } : {}),
    ...(patch.questions !== undefined ? { questions: [...patch.questions] } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {})
  };
}

export class PostgresSeedPlanStore implements SeedPlanStore {
  constructor(private readonly pool: pg.Pool) {}

  async create(plan: NewSeedPlan): Promise<SeedPlan> {
    const items: SeedPlanItem[] = plan.items.map((item) => ({
      ...item,
      id: randomUUID(),
      status: "proposed" as const
    }));
    // Idempotent on outline_job_id: a completion replay inserts nothing and the
    // re-select below returns the plan the first delivery created.
    const inserted = await this.pool.query<SeedPlanRow>(
      `
        INSERT INTO seed_plans (
          id, flow_id, status, origin, charter, persona, charter_proposed,
          persona_proposed, items, rationale, notes, outline_job_id, source_hash
        )
        VALUES ($1, $2, 'proposed', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (outline_job_id) DO NOTHING
        RETURNING *
      `,
      [
        randomUUID(),
        plan.flowId,
        plan.origin,
        plan.charter ?? null,
        plan.persona ?? null,
        plan.charterProposed,
        plan.personaProposed,
        JSON.stringify(items),
        plan.rationale,
        plan.notes ?? null,
        plan.outlineJobId,
        plan.sourceHash
      ]
    );
    if (inserted.rows[0]) {
      return mapRow(inserted.rows[0]);
    }
    const existing = await this.pool.query<SeedPlanRow>("SELECT * FROM seed_plans WHERE outline_job_id = $1", [
      plan.outlineJobId
    ]);
    return mapRow(existing.rows[0]);
  }

  async get(id: string): Promise<SeedPlan | undefined> {
    const result = await this.pool.query<SeedPlanRow>("SELECT * FROM seed_plans WHERE id = $1", [id]);
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async listByFlow(flowId: string): Promise<SeedPlan[]> {
    const result = await this.pool.query<SeedPlanRow>(
      "SELECT * FROM seed_plans WHERE flow_id = $1 ORDER BY created_at DESC, id DESC",
      [flowId]
    );
    return result.rows.map(mapRow);
  }

  async latestByFlow(flowId: string, status: SeedPlanStatus): Promise<SeedPlan | undefined> {
    const result = await this.pool.query<SeedPlanRow>(
      "SELECT * FROM seed_plans WHERE flow_id = $1 AND status = $2 ORDER BY created_at DESC, id DESC LIMIT 1",
      [flowId, status]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async setStatus(id: string, status: SeedPlanStatus): Promise<SeedPlan | undefined> {
    const result = await this.pool.query<SeedPlanRow>(
      "UPDATE seed_plans SET status = $2, updated_at = now() WHERE id = $1 RETURNING *",
      [id, status]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async patch(
    id: string,
    patch: { charter?: string; persona?: string; items?: SeedPlanItemPatch[] }
  ): Promise<SeedPlan | undefined> {
    // Read-modify-write inside a transaction with the row locked: item patches
    // merge into the JSONB array, and concurrent patches serialize.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<SeedPlanRow>("SELECT * FROM seed_plans WHERE id = $1 FOR UPDATE", [id]);
      if (!current.rows[0]) {
        await client.query("ROLLBACK");
        return undefined;
      }
      const patchesById = new Map((patch.items ?? []).map((itemPatch) => [itemPatch.id, itemPatch]));
      const items = current.rows[0].items.map((item) => {
        const itemPatch = patchesById.get(item.id);
        return itemPatch ? patchItem(item, itemPatch) : item;
      });
      const result = await client.query<SeedPlanRow>(
        `
          UPDATE seed_plans
          SET charter = COALESCE($2, charter),
              persona = COALESCE($3, persona),
              items = $4,
              updated_at = now()
          WHERE id = $1
          RETURNING *
        `,
        [id, patch.charter ?? null, patch.persona ?? null, JSON.stringify(items)]
      );
      await client.query("COMMIT");
      return result.rows[0] ? mapRow(result.rows[0]) : undefined;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async revise(
    id: string,
    next: {
      items: Omit<SeedPlanItem, "id" | "status" | "draftJobId">[];
      charter?: string;
      persona?: string;
      rationale: string;
    }
  ): Promise<SeedPlan | undefined> {
    // A whole-items replacement: fresh proposed ids like create, plus rationale
    // and (when provided) charter/persona. COALESCE keeps the existing
    // charter/persona when the revision did not change them.
    const items: SeedPlanItem[] = next.items.map((item) => ({
      ...item,
      id: randomUUID(),
      status: "proposed" as const
    }));
    const result = await this.pool.query<SeedPlanRow>(
      `
        UPDATE seed_plans
        SET charter = COALESCE($2, charter),
            persona = COALESCE($3, persona),
            items = $4,
            rationale = $5,
            updated_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [id, next.charter ?? null, next.persona ?? null, JSON.stringify(items), next.rationale]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async setItemDraftJob(id: string, itemId: string, draftJobId: string): Promise<SeedPlan | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<SeedPlanRow>("SELECT * FROM seed_plans WHERE id = $1 FOR UPDATE", [id]);
      if (!current.rows[0]) {
        await client.query("ROLLBACK");
        return undefined;
      }
      const items = current.rows[0].items.map((item) => (item.id === itemId ? { ...item, draftJobId } : item));
      const result = await client.query<SeedPlanRow>(
        "UPDATE seed_plans SET items = $2, updated_at = now() WHERE id = $1 RETURNING *",
        [id, JSON.stringify(items)]
      );
      await client.query("COMMIT");
      return result.rows[0] ? mapRow(result.rows[0]) : undefined;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async reset(): Promise<void> {
    await this.pool.query("DELETE FROM seed_plans");
  }
}
