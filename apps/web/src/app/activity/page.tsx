"use client";

import { ActivityPanel } from "../../components/ActivityPanel";
import { useConsole } from "../../components/ConsoleProvider";
import { Workbench } from "../../components/ui";
import { knowledgeFlows } from "../../lib/config";

export default function ActivityPage() {
  const { config, maintenanceRuns } = useConsole();

  return (
    <Workbench>
      <ActivityPanel flows={knowledgeFlows(config)} runs={maintenanceRuns} />
    </Workbench>
  );
}
