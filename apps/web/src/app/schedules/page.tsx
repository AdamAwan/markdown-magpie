"use client";

import { useConsole } from "../../components/ConsoleProvider";
import { SchedulesPanel } from "../../components/SchedulesPanel";
import { knowledgeFlows } from "../../lib/config";

export default function SchedulesPage() {
  const { config, loading, runScheduledTask, saveScheduledTask, scheduledTasks } = useConsole();

  return (
    <section className="fullWorkbench">
      <SchedulesPanel
        flows={knowledgeFlows(config)}
        loading={loading}
        onRunTask={runScheduledTask}
        onSaveTask={saveScheduledTask}
        scheduledTasks={scheduledTasks}
      />
    </section>
  );
}
