"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, errorMessage } from "../../lib/api";
import type {
  FunnelStage,
  GapBacklogBucket,
  JobThroughputBucket,
  LatencyBin,
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

// Gap-to-merge funnel: one count per pipeline stage over the last 30 days (the
// v1 fixed window). Stages arrive in pipeline order.
export function useFunnel(): InsightsResource<FunnelStage[]> {
  const resource = useInsightsResource<{ stages: FunnelStage[] }>("/insights/funnel");
  return {
    data: resource.data?.stages,
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
