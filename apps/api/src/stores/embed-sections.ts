import type { EmbeddingProvider } from "@magpie/core";
import { logger } from "../logger.js";
import type { EmbeddingPersistence, SectionToEmbed } from "./knowledge-index.js";

export interface EmbedPendingOptions {
  store: EmbeddingPersistence;
  provider: EmbeddingProvider;
  repositoryId?: string;
  batchSize?: number;
  // Retry policy for transient provider failures (429, 5xx, timeouts, network).
  // Injectable so tests need not wait out real backoff.
  retry?: Partial<EmbedRetryPolicy>;
}

export interface EmbedRetryPolicy {
  // Total provider calls per batch before the failure is surfaced.
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep: (ms: number) => Promise<void>;
}

export interface EmbedPendingResult {
  embeddedCount: number;
  // Sections the provider rejected even after truncation; recorded as skipped
  // in the store so they no longer block the sections behind them.
  skippedCount: number;
  remaining: number;
}

const DEFAULT_BATCH_SIZE = 64;

// Upper bound on the characters sent for one section (docs/ingestion.md IN29).
// The supported embedding models cap input at 8191 TOKENS and fail the whole
// request — every section in the batch — when one input is over. There is no
// tokenizer in the API, so this is a conservative character budget: English
// prose averages ~4 characters per token, so 24k characters (~6k tokens) leaves
// room for denser text such as code or non-Latin scripts. A section longer than
// this is embedded from its leading text (heading first), which is what its
// vector is mostly about anyway; a section that STILL fails is skipped (IN31).
export const MAX_EMBED_INPUT_CHARS = 24_000;

const DEFAULT_RETRY: EmbedRetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
};

/**
 * Embeds every section missing an embedding, in batches, idempotently. Only
 * targets sections the store lists as pending, so retries and partial failures
 * are safe and re-indexed (re-inserted) sections are picked up here.
 *
 * Resilience (docs/ingestion.md IN29–IN32):
 * - oversized text is truncated to MAX_EMBED_INPUT_CHARS before it is sent;
 * - a transient failure (429, 5xx, timeout, network) is retried with
 *   exponential backoff, honouring a provider-supplied Retry-After;
 * - a batch that still fails is bisected to find the section(s) the provider
 *   rejects. When part of the batch embeds, the provider is demonstrably up, so
 *   the sections that keep failing are recorded as skipped and the rest proceed.
 *   When nothing in the batch embeds, the failure is treated as an outage and
 *   rethrown — an outage must never be mistaken for a corpus of bad sections.
 */
export async function embedPendingSections(options: EmbedPendingOptions): Promise<EmbedPendingResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const retry: EmbedRetryPolicy = { ...DEFAULT_RETRY, ...options.retry };
  const embed = (sections: SectionToEmbed[]) => embedWithRetry(options.provider, sections, retry);
  let embeddedCount = 0;
  let skippedCount = 0;
  // Sections we've already tried to embed. If a pass returns only these, the
  // store isn't clearing them (e.g. saveSectionEmbedding silently no-ops), so we
  // stop rather than spin forever.
  const attempted = new Set<string>();

  for (;;) {
    const pending = await options.store.listSectionsNeedingEmbedding(batchSize, options.repositoryId);
    if (pending.length === 0) {
      break;
    }
    if (pending.every((section) => attempted.has(section.id))) {
      break;
    }
    for (const section of pending) {
      attempted.add(section.id);
    }

    const { embedded, rejected } = await embedIsolatingRejects(pending, embed);
    if (embedded.length > 0) {
      // One multi-row write per provider batch instead of one round-trip per section.
      await options.store.saveSectionEmbeddings(embedded);
      embeddedCount += embedded.length;
    }
    if (rejected.length > 0) {
      const skips = rejected.map(({ section, error }) => ({ id: section.id, reason: describeError(error) }));
      await options.store.markSectionsEmbeddingSkipped(skips);
      skippedCount += skips.length;
      logger.warn(
        { sections: skips.map((skip) => skip.id), reasons: [...new Set(skips.map((skip) => skip.reason))] },
        "embedding provider rejected section(s); skipped so the rest can proceed"
      );
    }
  }

  const remaining = await options.store.countSectionsNeedingEmbedding(options.repositoryId);
  return { embeddedCount, skippedCount, remaining };
}

interface IsolationResult {
  embedded: Array<{ id: string; embedding: number[] }>;
  rejected: Array<{ section: SectionToEmbed; error: unknown }>;
}

type EmbedBatch = (sections: SectionToEmbed[]) => Promise<number[][]>;

// Embeds a batch, and when it fails, splits it to find what the provider
// rejects. The first split is the outage test: if neither half embeds, the
// provider is failing everything and the original error is rethrown, nothing
// skipped. Once either half has embedded, deeper failures are attributable to
// the sections themselves and are bisected down to single rejected sections.
async function embedIsolatingRejects(sections: SectionToEmbed[], embed: EmbedBatch): Promise<IsolationResult> {
  try {
    return { embedded: pairVectors(sections, await embed(sections)), rejected: [] };
  } catch (error) {
    if (sections.length === 1) {
      // A lone section has no sibling to prove the provider is up. Only a
      // definite client error (a 4xx the provider would repeat) convicts it.
      if (isDefiniteRejection(error)) {
        return { embedded: [], rejected: [{ section: sections[0], error }] };
      }
      throw error;
    }
    if (!isPerInputCandidate(error)) {
      throw error;
    }
    const [left, right] = halves(sections);
    const [leftResult, rightResult] = await Promise.allSettled([embed(left), embed(right)]);
    if (leftResult.status === "rejected" && rightResult.status === "rejected") {
      throw error;
    }
    const result: IsolationResult = { embedded: [], rejected: [] };
    const outcomes: Array<{ half: SectionToEmbed[]; outcome: PromiseSettledResult<number[][]> }> = [
      { half: left, outcome: leftResult },
      { half: right, outcome: rightResult }
    ];
    for (const { half, outcome } of outcomes) {
      if (outcome.status === "fulfilled") {
        result.embedded.push(...pairVectors(half, outcome.value));
      } else {
        const isolated = await bisect(half, embed, outcome.reason);
        result.embedded.push(...isolated.embedded);
        result.rejected.push(...isolated.rejected);
      }
    }
    return result;
  }
}

// Bisects a group already known to fail while the provider is known to be up.
// Rate limiting (or a contract violation) part-way through says nothing about
// the inputs, so it aborts the pass rather than convicting the group; the
// pass is re-run later and nothing is skipped.
async function bisect(sections: SectionToEmbed[], embed: EmbedBatch, error: unknown): Promise<IsolationResult> {
  if (!isPerInputCandidate(error)) {
    throw error;
  }
  if (sections.length === 1) {
    return { embedded: [], rejected: [{ section: sections[0], error }] };
  }
  const result: IsolationResult = { embedded: [], rejected: [] };
  for (const half of halves(sections)) {
    try {
      result.embedded.push(...pairVectors(half, await embed(half)));
    } catch (halfError) {
      const isolated = await bisect(half, embed, halfError);
      result.embedded.push(...isolated.embedded);
      result.rejected.push(...isolated.rejected);
    }
  }
  return result;
}

function halves<T>(items: T[]): [T[], T[]] {
  const middle = Math.ceil(items.length / 2);
  return [items.slice(0, middle), items.slice(middle)];
}

function pairVectors(sections: SectionToEmbed[], vectors: number[][]): Array<{ id: string; embedding: number[] }> {
  return sections.map((section, index) => ({ id: section.id, embedding: vectors[index] }));
}

// One provider call for a batch, retried with backoff while the failure looks
// transient. A response with the wrong number of vectors is a provider contract
// violation, not a property of any one input, so it throws ContractViolation —
// never retried, never bisected.
async function embedWithRetry(
  provider: EmbeddingProvider,
  sections: SectionToEmbed[],
  retry: EmbedRetryPolicy
): Promise<number[][]> {
  const texts = sections.map((section) => truncateForEmbedding(section.text));
  for (let attempt = 1; ; attempt += 1) {
    let vectors: number[][];
    try {
      vectors = await provider.embed(texts);
    } catch (error) {
      if (attempt >= retry.maxAttempts || !isTransient(error)) {
        throw error;
      }
      const backoff = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1));
      const delay = Math.min(retry.maxDelayMs, Math.max(backoff, retryAfterMs(error) ?? 0));
      logger.debug({ attempt, delayMs: delay, err: describeError(error) }, "embedding batch failed; retrying");
      await retry.sleep(delay);
      continue;
    }
    if (vectors.length !== sections.length) {
      throw new EmbeddingContractViolation(
        `Embedding provider returned ${vectors.length} vector(s) for ${sections.length} section(s); refusing to embed a mismatched batch`
      );
    }
    return vectors;
  }
}

class EmbeddingContractViolation extends Error {}

export function truncateForEmbedding(text: string): string {
  if (text.length <= MAX_EMBED_INPUT_CHARS) {
    return text;
  }
  // Don't split a UTF-16 surrogate pair: a lone high surrogate is invalid JSON
  // text to some providers.
  let end = MAX_EMBED_INPUT_CHARS;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1;
  }
  return text.slice(0, end);
}

// The HTTP status a provider error carries, if it exposes one as a numeric
// `status` property. The current @magpie/retrieval providers throw a plain Error
// whose message embeds the status, so today this is usually undefined and the
// error is classified by the conservative defaults below.
function errorStatus(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "status" in error && typeof error.status === "number") {
    return error.status;
  }
  return undefined;
}

// A provider-supplied Retry-After, in milliseconds, if the error exposes one as
// a numeric `retryAfterMs` property.
function retryAfterMs(error: unknown): number | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "retryAfterMs" in error &&
    typeof error.retryAfterMs === "number" &&
    Number.isFinite(error.retryAfterMs) &&
    error.retryAfterMs >= 0
  ) {
    return error.retryAfterMs;
  }
  return undefined;
}

// Worth retrying the identical request: rate limiting, server errors, request
// timeouts, and — absent a status — anything else (timeouts, connection resets).
// A definite client error (4xx other than 408/429) would fail identically again.
function isTransient(error: unknown): boolean {
  if (error instanceof EmbeddingContractViolation) {
    return false;
  }
  const status = errorStatus(error);
  if (status === undefined) {
    return true;
  }
  return status === 408 || status === 429 || status >= 500;
}

// A provider-reported client error that is about the request itself (bad or
// oversized input), not rate limiting or a timeout.
function isDefiniteRejection(error: unknown): boolean {
  const status = errorStatus(error);
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

// Could this failure be caused by one particular input, so that splitting the
// batch might isolate it? Not a contract violation, and not rate limiting
// (which a split only makes worse).
function isPerInputCandidate(error: unknown): boolean {
  return !(error instanceof EmbeddingContractViolation) && errorStatus(error) !== 429;
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}
