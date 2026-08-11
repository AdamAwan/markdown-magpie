import { randomUUID } from "node:crypto";
import type { QuestionnaireImport, SheetGrid, SheetMapping } from "@magpie/core";

// An uploaded questionnaire file, staged between upload and the operator
// confirming its column mapping (docs/questionnaires.md Q29+).
//
// The row shape itself lives in @magpie/core because it crosses the HTTP
// boundary to the console; the grid does not, and is read through its own
// accessor so no route can accidentally serialise a whole customer workbook.
export type { QuestionnaireImport };

export interface QuestionnaireImportCreate {
  flowId: string;
  name: string;
  filename: string;
  format: "xlsx" | "csv";
  sheets: SheetGrid[];
}

export interface QuestionnaireImportStore {
  create(input: QuestionnaireImportCreate): Promise<QuestionnaireImport>;
  get(id: string): Promise<QuestionnaireImport | undefined>;
  // The extracted grid, or undefined once it has been dropped on confirm.
  sheets(id: string): Promise<SheetGrid[] | undefined>;
  byJobId(jobId: string): Promise<QuestionnaireImport | undefined>;
  attachJob(id: string, jobId: string): Promise<void>;
  markMapped(id: string, mapping: SheetMapping[]): Promise<void>;
  // A failed mapping KEEPS the grid: the operator can map by hand or the job can
  // be re-run, which is what makes the failure recoverable without a re-upload.
  markFailed(id: string, error: string): Promise<void>;
  confirm(id: string, input: { questionnaireId: string; mapping: SheetMapping[] }): Promise<void>;
  remove(id: string): Promise<void>;
  // Deletes unconfirmed imports created before `cutoffIso`, returning how many
  // went. Called lazily on upload rather than on a timer, so a restart can never
  // strand customer material behind a wedged sweep.
  sweep(cutoffIso: string): Promise<number>;
  reset(): Promise<void>;
}

interface StoredImport {
  row: QuestionnaireImport;
  sheets?: SheetGrid[];
}

export class InMemoryQuestionnaireImportStore implements QuestionnaireImportStore {
  private readonly imports = new Map<string, StoredImport>();

  async create(input: QuestionnaireImportCreate): Promise<QuestionnaireImport> {
    const row: QuestionnaireImport = {
      id: randomUUID(),
      flowId: input.flowId,
      name: input.name,
      filename: input.filename,
      format: input.format,
      status: "mapping",
      createdAt: new Date().toISOString()
    };
    this.imports.set(row.id, { row, sheets: input.sheets });
    return row;
  }

  async get(id: string): Promise<QuestionnaireImport | undefined> {
    return this.imports.get(id)?.row;
  }

  async sheets(id: string): Promise<SheetGrid[] | undefined> {
    return this.imports.get(id)?.sheets;
  }

  async byJobId(jobId: string): Promise<QuestionnaireImport | undefined> {
    return [...this.imports.values()].find((entry) => entry.row.jobId === jobId)?.row;
  }

  async attachJob(id: string, jobId: string): Promise<void> {
    this.patch(id, { jobId });
  }

  async markMapped(id: string, mapping: SheetMapping[]): Promise<void> {
    this.patch(id, { status: "mapped", mapping });
  }

  async markFailed(id: string, error: string): Promise<void> {
    this.patch(id, { status: "failed", error });
  }

  async confirm(id: string, input: { questionnaireId: string; mapping: SheetMapping[] }): Promise<void> {
    const entry = this.imports.get(id);
    if (!entry) {
      return;
    }
    // The grid goes the moment it has served its purpose.
    delete entry.sheets;
    entry.row = { ...entry.row, status: "confirmed", questionnaireId: input.questionnaireId, mapping: input.mapping };
  }

  async remove(id: string): Promise<void> {
    this.imports.delete(id);
  }

  async sweep(cutoffIso: string): Promise<number> {
    let deleted = 0;
    for (const [id, entry] of this.imports) {
      if (entry.row.status !== "confirmed" && entry.row.createdAt < cutoffIso) {
        this.imports.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }

  async reset(): Promise<void> {
    this.imports.clear();
  }

  // Test seam for the sweep: the in-memory store has no clock to travel.
  setCreatedAtForTest(id: string, createdAt: string): void {
    this.patch(id, { createdAt });
  }

  private patch(id: string, patch: Partial<QuestionnaireImport>): void {
    const entry = this.imports.get(id);
    if (entry) {
      entry.row = { ...entry.row, ...patch };
    }
  }
}
