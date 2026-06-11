import { randomUUID } from "node:crypto";
import type { AiJob, AiJobQueue, AiJobType } from "@magpie/core";

export class InMemoryAiJobQueue implements AiJobQueue {
  private readonly jobs = new Map<string, AiJob>();

  async enqueue<TInput>(type: AiJobType, input: TInput): Promise<AiJob<TInput>> {
    const now = new Date().toISOString();
    const job: AiJob<TInput> = {
      id: randomUUID(),
      type,
      status: "pending",
      input,
      createdAt: now,
      updatedAt: now
    };

    this.jobs.set(job.id, job);
    return job;
  }

  async claimNext(workerName: string, acceptedTypes: AiJobType[]): Promise<AiJob | undefined> {
    const now = new Date().toISOString();
    const job = [...this.jobs.values()]
      .filter((candidate) => candidate.status === "pending" && acceptedTypes.includes(candidate.type))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];

    if (!job) {
      return undefined;
    }

    const claimed: AiJob = {
      ...job,
      status: "claimed",
      claimedBy: workerName,
      updatedAt: now
    };

    this.jobs.set(claimed.id, claimed);
    return claimed;
  }

  async complete<TOutput>(jobId: string, output: TOutput): Promise<void> {
    const job = this.getExisting(jobId);
    this.jobs.set(jobId, {
      ...job,
      status: "completed",
      output,
      error: undefined,
      updatedAt: new Date().toISOString()
    });
  }

  async fail(jobId: string, error: string): Promise<void> {
    const job = this.getExisting(jobId);
    this.jobs.set(jobId, {
      ...job,
      status: "failed",
      error,
      updatedAt: new Date().toISOString()
    });
  }

  async get(jobId: string): Promise<AiJob | undefined> {
    return this.jobs.get(jobId);
  }

  async list(): Promise<AiJob[]> {
    return [...this.jobs.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private getExisting(jobId: string): AiJob {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`AI job not found: ${jobId}`);
    }

    return job;
  }
}
