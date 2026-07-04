"use client";

import { useMemo } from "react";
import { SeedPanel } from "../../components/SeedPanel";
import { useConsole } from "../../components/ConsoleProvider";
import { Surface, Workbench } from "../../components/ui";
import { knowledgeFlows } from "../../lib/config";

export default function SeedPage() {
  const { config, loading, generateOutline, seedFlow } = useConsole();

  const flows = useMemo(
    () => knowledgeFlows(config).map((flow) => ({ id: flow.id, name: flow.name })),
    [config]
  );

  return (
    <Workbench>
      <Surface>
        <Surface.Header>
          <h2>Seed / add an area</h2>
        </Surface.Header>
        <Surface.Body>
          <SeedPanel flows={flows} loading={loading} onGenerate={generateOutline} onSeed={seedFlow} />
        </Surface.Body>
      </Surface>
    </Workbench>
  );
}
