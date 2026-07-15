"use client";

import { useCallback, useEffect, useState } from "react";
import { useConsole } from "../../components/ConsoleProvider";
import { SchedulesPanel } from "../../components/SchedulesPanel";
import { Workbench } from "../../components/ui";
import { apiGet } from "../../lib/api";
import { knowledgeFlows } from "../../lib/config";
import type { AiScheduleCost } from "../../lib/types";

export default function SchedulesPage() {
  const { config, loading, runScheduledTask, saveScheduledTask, scheduledTasks } = useConsole();

  // Per-schedule AI cost is fetched page-locally (like the Insights aggregates)
  // rather than through the console's fast poll — it is a heavier rollup that does
  // not need to refresh every few seconds. Keyed by ScheduledTask.key.
  const [costByKey, setCostByKey] = useState<Map<string, AiScheduleCost>>(new Map());

  const loadCosts = useCallback((signal: AbortSignal) => {
    apiGet<{ schedules: AiScheduleCost[] }>("/insights/ai-cost/by-schedule", { signal })
      .then((result) => setCostByKey(new Map(result.schedules.map((cost) => [cost.key, cost]))))
      .catch(() => {
        // Cost is a non-critical adornment on the schedules table; on failure (or
        // abort) the rows simply render without it rather than blocking the page.
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadCosts(controller.signal);
    return () => controller.abort();
  }, [loadCosts]);

  return (
    <Workbench>
      <SchedulesPanel
        costByKey={costByKey}
        flows={knowledgeFlows(config)}
        loading={loading}
        onRunTask={runScheduledTask}
        onSaveTask={saveScheduledTask}
        scheduledTasks={scheduledTasks}
      />
    </Workbench>
  );
}
