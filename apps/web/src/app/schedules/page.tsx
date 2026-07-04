"use client";

import { useConsole } from "../../components/ConsoleProvider";
import { SchedulesPanel } from "../../components/SchedulesPanel";
import { Workbench } from "../../components/ui";
import { knowledgeFlows } from "../../lib/config";

export default function SchedulesPage() {
  const { config, loading, runScheduledTask, saveScheduledTask, scheduledTasks } = useConsole();

  return (
    <Workbench>
      <SchedulesPanel
        flows={knowledgeFlows(config)}
        loading={loading}
        onRunTask={runScheduledTask}
        onSaveTask={saveScheduledTask}
        scheduledTasks={scheduledTasks}
      />
    </Workbench>
  );
}
