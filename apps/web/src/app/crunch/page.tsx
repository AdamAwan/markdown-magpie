"use client";

import { useConsole } from "../../components/ConsoleProvider";
import { CrunchPanel } from "../../components/CrunchPanel";
import { knowledgeFlows } from "../../lib/config";

export default function CrunchPage() {
  const {
    config,
    loading,
    publishCrunchRun,
    runCrunch,
    runScheduledTask,
    saveCrunchSchedule,
    saveScheduledTask,
    crunchRuns,
    scheduledTasks,
    crunchSettings
  } = useConsole();

  return (
    <section className="fullWorkbench">
      <CrunchPanel
        flows={knowledgeFlows(config)}
        loading={loading}
        onPublish={publishCrunchRun}
        onRun={runCrunch}
        onRunTask={runScheduledTask}
        onSaveSchedule={saveCrunchSchedule}
        onSaveTask={saveScheduledTask}
        runs={crunchRuns}
        scheduledTasks={scheduledTasks}
        settings={crunchSettings}
      />
    </section>
  );
}
