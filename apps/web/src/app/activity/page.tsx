"use client";

import { ActivityPanel } from "../../components/ActivityPanel";
import { useConsole } from "../../components/ConsoleProvider";
import { knowledgeFlows } from "../../lib/config";

export default function ActivityPage() {
  const { config, maintenanceRuns } = useConsole();

  return (
    <section className="workbench singlePane">
      <ActivityPanel flows={knowledgeFlows(config)} runs={maintenanceRuns} />
    </section>
  );
}
