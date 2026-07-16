"use client";

import { useMemo } from "react";
import { SeedPanel } from "../../components/SeedPanel";
import { useConsole } from "../../components/ConsoleProvider";
import { Surface, Workbench } from "../../components/ui";
import { knowledgeFlows } from "../../lib/config";

export default function SeedPage() {
  const {
    config,
    loading,
    proposeSeedPlan,
    listSeedPlans,
    patchSeedPlan,
    approveSeedPlan,
    dismissSeedPlan,
    reviseSeedPlan
  } = useConsole();

  const flows = useMemo(
    () => knowledgeFlows(config).map((flow) => ({ id: flow.id, name: flow.name })),
    [config]
  );

  return (
    <Workbench>
      <Surface>
        <Surface.Header>
          <h2>Seed / plan a flow</h2>
        </Surface.Header>
        <Surface.Body>
          <SeedPanel
            flows={flows}
            loading={loading}
            onPropose={proposeSeedPlan}
            onListPlans={listSeedPlans}
            onPatch={patchSeedPlan}
            onApprove={approveSeedPlan}
            onDismiss={dismissSeedPlan}
            onRevise={reviseSeedPlan}
          />
        </Surface.Body>
      </Surface>
    </Workbench>
  );
}
