"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, errorMessage } from "../../lib/api";
import type { GapBacklogBucket } from "../../lib/types";

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
