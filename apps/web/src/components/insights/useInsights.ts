"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, errorMessage } from "../../lib/api";
import type {
  AiUsageBreakdown,
  FeedbackBucket,
  FeedbackSummary,
  FreshnessSummary,
  JourneySankey,
  GapBacklogBucket,
  JobErrorBreakdown,
  JobThroughputBucket,
  LatencyBin,
  PatrolImpact,
  VerificationBucket,
  VerificationSummary
} from "../../lib/types";

// Page-local fetch state for a single insight series. The Insights page fetches
// on its own (not through ConsoleProvider) so the heavier aggregates stay out of
// the global 4s poll; callers get an explicit refresh() for the manual button.
export interface InsightsResource<T> {
  data: T | undefined;
  loading: boolean;
  error: string | undefined;
  refresh: () => void;
}

function useInsightsResource<T>(path: string): InsightsResource<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    apiGet<T>(path, { signal: controller.signal })
      .then((result) => setData(result))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, nonce]);

  return { data, loading, error, refresh };
}

// Open-gap backlog trend (last 30 days, daily buckets — the v1 fixed window).
export function useGapBacklog(): InsightsResource<GapBacklogBucket[]> {
  const resource = useInsightsResource<{ series: GapBacklogBucket[] }>("/insights/gaps/backlog?bucket=day");
  return {
    data: resource.data?.series,
    loading: resource.loading,
    error: resource.error,
    refresh: resource.refresh
  };
}

// Question-journey Sankey: a { nodes, links } graph of the path questions take
// through gaps, clusters, proposals, and verification over the last 30 days (the
// v1 fixed window).
export function useJourney(): InsightsResource<JourneySankey> {
  const resource = useInsightsResource<JourneySankey>("/insights/journey");
  return {
    data: resource.data,
    loading: resource.loading,
    error: resource.error,
    refresh: resource.refresh
  };
}

// Job throughput & health (last 30 days, daily buckets — the v1 fixed window).
export function useJobThroughput(): InsightsResource<JobThroughputBucket[]> {
  const resource = useInsightsResource<{ series: JobThroughputBucket[] }>("/insights/jobs/throughput?bucket=day");
  return {
    data: resource.data?.series,
    loading: resource.loading,
    error: resource.error,
    refresh: resource.refresh
  };
}

// Answer-latency histogram (last 30 days). Binned by latency range, not time.
export function useAnswerLatency(): InsightsResource<LatencyBin[]> {
  const resource = useInsightsResource<{ bins: LatencyBin[] }>("/insights/answers/latency");
  return {
    data: resource.data?.bins,
    loading: resource.loading,
    error: resource.error,
    refresh: resource.refresh
  };
}

// The verification-success payload: overall totals plus a per-bucket trend.
export interface VerificationSuccessData {
  totals: VerificationSummary;
  series: VerificationBucket[];
}

// Verification success rate (last 30 days, daily buckets).
export function useVerificationSuccess(): InsightsResource<VerificationSuccessData> {
  const resource = useInsightsResource<VerificationSuccessData>("/insights/verification/success?bucket=day");
  return {
    data: resource.data,
    loading: resource.loading,
    error: resource.error,
    refresh: resource.refresh
  };
}

// The job-error-breakdown payload (C6): failed jobs split by category and by type.
export interface JobErrorsData {
  byCategory: JobErrorBreakdown[];
  byType: JobErrorBreakdown[];
}

// Job error breakdown (last 30 days). Failed jobs grouped by error category and by
// job type.
export function useJobErrors(): InsightsResource<JobErrorsData> {
  const resource = useInsightsResource<JobErrorsData>("/insights/jobs/errors");
  return {
    data: resource.data,
    loading: resource.loading,
    error: resource.error,
    refresh: resource.refresh
  };
}

// Knowledge-base freshness (C7). A point-in-time snapshot, no window.
export function useFreshness(): InsightsResource<FreshnessSummary> {
  const resource = useInsightsResource<FreshnessSummary>("/insights/freshness");
  return {
    data: resource.data,
    loading: resource.loading,
    error: resource.error,
    refresh: resource.refresh
  };
}

// The answer-feedback payload (C10): overall totals plus a per-bucket trend.
export interface AnswerFeedbackData {
  totals: FeedbackSummary;
  series: FeedbackBucket[];
}

// Answer feedback (last 30 days, daily buckets): helpful/unhelpful verdicts and
// the unhelpful rate, with unhelpful-on-confident-answer called out (#241).
export function useAnswerFeedback(): InsightsResource<AnswerFeedbackData> {
  const resource = useInsightsResource<AnswerFeedbackData>("/insights/feedback?bucket=day");
  return {
    data: resource.data,
    loading: resource.loading,
    error: resource.error,
    refresh: resource.refresh
  };
}

// Maintenance patrol impact (last 30 days), one row per task type.
export function usePatrolImpact(): InsightsResource<PatrolImpact[]> {
  const resource = useInsightsResource<{ runs: PatrolImpact[] }>("/insights/patrols");
  return {
    data: resource.data?.runs,
    loading: resource.loading,
    error: resource.error,
    refresh: resource.refresh
  };
}

// AI token usage (last 30 days), one row per (job type, provider) pair (#241).
export function useAiUsage(): InsightsResource<AiUsageBreakdown[]> {
  const resource = useInsightsResource<{ usage: AiUsageBreakdown[] }>("/insights/ai-usage");
  return {
    data: resource.data?.usage,
    loading: resource.loading,
    error: resource.error,
    refresh: resource.refresh
  };
}
