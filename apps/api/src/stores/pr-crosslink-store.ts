export interface PrCrosslinkRecord {
  id: string;
  flowId?: string;
  proposalLow: string;
  proposalHigh: string;
  targets: string[];
  linkedAt: string;
}

export interface NewPrCrosslink {
  flowId?: string;
  proposalA: string;
  proposalB: string;
  targets: string[];
}

// Records that two open PRs were cross-linked once, so the reconciler does not
// re-comment them every tick. The pair is order-independent.
export interface PrCrosslinkStore {
  has(a: string, b: string): Promise<boolean>;
  record(input: NewPrCrosslink): Promise<PrCrosslinkRecord>;
  list(limit: number): Promise<PrCrosslinkRecord[]>;
  reset(): Promise<void>;
}

// Normalise a pair so (a,b) and (b,a) key identically.
export function normalisePair(a: string, b: string): { low: string; high: string } {
  return a <= b ? { low: a, high: b } : { low: b, high: a };
}

export class InMemoryPrCrosslinkStore implements PrCrosslinkStore {
  private readonly links: PrCrosslinkRecord[] = [];
  private seq = 0;

  async has(a: string, b: string): Promise<boolean> {
    const { low, high } = normalisePair(a, b);
    return this.links.some((l) => l.proposalLow === low && l.proposalHigh === high);
  }

  async record(input: NewPrCrosslink): Promise<PrCrosslinkRecord> {
    const { low, high } = normalisePair(input.proposalA, input.proposalB);
    const existing = this.links.find((l) => l.proposalLow === low && l.proposalHigh === high);
    if (existing) {
      return existing;
    }
    this.seq += 1;
    const record: PrCrosslinkRecord = {
      id: `crosslink-${this.seq}`,
      flowId: input.flowId,
      proposalLow: low,
      proposalHigh: high,
      targets: input.targets,
      linkedAt: new Date().toISOString()
    };
    this.links.push(record);
    return record;
  }

  async list(limit: number): Promise<PrCrosslinkRecord[]> {
    return [...this.links].reverse().slice(0, limit);
  }

  async reset(): Promise<void> {
    this.links.length = 0;
    this.seq = 0;
  }
}
