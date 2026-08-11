import { randomUUID } from "node:crypto";
import pg from "pg";
import type { QuestionnaireImport, QuestionnaireImportStatus, SheetGrid, SheetMapping } from "@magpie/core";
import type { QuestionnaireImportCreate, QuestionnaireImportStore } from "./questionnaire-import-store.js";

interface QuestionnaireImportRow {
  id: string;
  flow_id: string;
  name: string;
  filename: string;
  format: "xlsx" | "csv";
  status: QuestionnaireImportStatus;
  mapping: SheetMapping[] | null;
  error: string | null;
  questionnaire_id: string | null;
  job_id: string | null;
  created_at: Date;
}

// Every column except `sheets`: the grid is deliberately absent from the row
// shape so no read path can serialise a whole customer workbook by accident.
const ROW_COLUMNS = "id, flow_id, name, filename, format, status, mapping, error, questionnaire_id, job_id, created_at";

function mapRow(row: QuestionnaireImportRow): QuestionnaireImport {
  return {
    id: row.id,
    flowId: row.flow_id,
    name: row.name,
    filename: row.filename,
    format: row.format,
    status: row.status,
    ...(row.mapping !== null ? { mapping: row.mapping } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    ...(row.questionnaire_id !== null ? { questionnaireId: row.questionnaire_id } : {}),
    ...(row.job_id !== null ? { jobId: row.job_id } : {}),
    createdAt: row.created_at.toISOString()
  };
}

export class PostgresQuestionnaireImportStore implements QuestionnaireImportStore {
  constructor(private readonly pool: pg.Pool) {}

  async create(input: QuestionnaireImportCreate): Promise<QuestionnaireImport> {
    const result = await this.pool.query<QuestionnaireImportRow>(
      `
        INSERT INTO questionnaire_imports (id, flow_id, name, filename, format, sheets)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING ${ROW_COLUMNS}
      `,
      [randomUUID(), input.flowId, input.name, input.filename, input.format, JSON.stringify(input.sheets)]
    );
    return mapRow(result.rows[0]);
  }

  async get(id: string): Promise<QuestionnaireImport | undefined> {
    const result = await this.pool.query<QuestionnaireImportRow>(
      `SELECT ${ROW_COLUMNS} FROM questionnaire_imports WHERE id = $1`,
      [id]
    );
    const row = result.rows[0];
    return row ? mapRow(row) : undefined;
  }

  async sheets(id: string): Promise<SheetGrid[] | undefined> {
    const result = await this.pool.query<{ sheets: SheetGrid[] | null }>(
      "SELECT sheets FROM questionnaire_imports WHERE id = $1",
      [id]
    );
    return result.rows[0]?.sheets ?? undefined;
  }

  async byJobId(jobId: string): Promise<QuestionnaireImport | undefined> {
    const result = await this.pool.query<QuestionnaireImportRow>(
      `SELECT ${ROW_COLUMNS} FROM questionnaire_imports WHERE job_id = $1`,
      [jobId]
    );
    const row = result.rows[0];
    return row ? mapRow(row) : undefined;
  }

  async attachJob(id: string, jobId: string): Promise<void> {
    await this.pool.query("UPDATE questionnaire_imports SET job_id = $2 WHERE id = $1", [id, jobId]);
  }

  async markMapped(id: string, mapping: SheetMapping[]): Promise<void> {
    await this.pool.query("UPDATE questionnaire_imports SET status = 'mapped', mapping = $2 WHERE id = $1", [
      id,
      JSON.stringify(mapping)
    ]);
  }

  async markFailed(id: string, error: string): Promise<void> {
    // The grid deliberately survives: a failed mapping stays recoverable by hand
    // or by re-running the job, without asking for the file again.
    await this.pool.query("UPDATE questionnaire_imports SET status = 'failed', error = $2 WHERE id = $1", [id, error]);
  }

  async confirm(id: string, input: { questionnaireId: string; mapping: SheetMapping[] }): Promise<void> {
    await this.pool.query(
      `
        UPDATE questionnaire_imports
        SET status = 'confirmed', questionnaire_id = $2, mapping = $3, sheets = NULL
        WHERE id = $1
      `,
      [id, input.questionnaireId, JSON.stringify(input.mapping)]
    );
  }

  async remove(id: string): Promise<void> {
    await this.pool.query("DELETE FROM questionnaire_imports WHERE id = $1", [id]);
  }

  async sweep(cutoffIso: string): Promise<number> {
    const result = await this.pool.query(
      "DELETE FROM questionnaire_imports WHERE status <> 'confirmed' AND created_at < $1",
      [cutoffIso]
    );
    return result.rowCount ?? 0;
  }

  async reset(): Promise<void> {
    await this.pool.query("DELETE FROM questionnaire_imports");
  }
}
