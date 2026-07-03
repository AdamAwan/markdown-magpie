"use client";

import { useMemo } from "react";
import { SeedPanel } from "../../components/SeedPanel";
import { useConsole } from "../../components/ConsoleProvider";
import { knowledgeFlows } from "../../lib/config";

export default function SeedPage() {
  const { config, loading, generateOutline, seedFlow } = useConsole();

  const flows = useMemo(
    () => knowledgeFlows(config).map((flow) => ({ id: flow.id, name: flow.name })),
    [config]
  );

  return (
    <section className="workbench singlePane">
      <div className="surface">
        <div className="surfaceHeader">
          <h2>Seed / add an area</h2>
        </div>
        <div className="surfaceBody">
          <SeedPanel flows={flows} loading={loading} onGenerate={generateOutline} onSeed={seedFlow} />
        </div>
      </div>
    </section>
  );
}
