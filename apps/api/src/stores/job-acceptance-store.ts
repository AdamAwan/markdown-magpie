export interface JobAcceptanceStore {
  accept(jobId: string): Promise<string>;
  getMany(jobIds: string[]): Promise<Map<string, string>>;
  clear(jobId: string): Promise<void>;
  reset(): Promise<void>;
}

export class InMemoryJobAcceptanceStore implements JobAcceptanceStore {
  private readonly accepted = new Map<string, string>();

  async accept(jobId: string): Promise<string> {
    const acceptedAt = this.accepted.get(jobId) ?? new Date().toISOString();
    this.accepted.set(jobId, acceptedAt);
    return acceptedAt;
  }

  async getMany(jobIds: string[]): Promise<Map<string, string>> {
    return new Map(
      jobIds.flatMap((id) => {
        const acceptedAt = this.accepted.get(id);
        return acceptedAt ? [[id, acceptedAt] as const] : [];
      })
    );
  }

  async clear(jobId: string): Promise<void> {
    this.accepted.delete(jobId);
  }

  async reset(): Promise<void> {
    this.accepted.clear();
  }
}
