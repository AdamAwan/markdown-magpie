"use client";

import { useMemo } from "react";
import { useConsole } from "../../components/ConsoleProvider";
import { GapClusterPanel, GapPanel } from "../../components/GapsPanel";
import { knowledgeFlows } from "../../lib/config";

export default function GapsPage() {
  const { gapClusters, gaps, draftCluster, draftProposal, loading, config } = useConsole();

  // Map flow id -> display name so gaps and clusters can be tagged with a
  // human-readable flow rather than the raw id.
  const flowLabels = useMemo(
    () => Object.fromEntries(knowledgeFlows(config).map((flow) => [flow.id, flow.name])),
    [config]
  );

  return (
    <section className="workbench singlePane">
      <GapClusterPanel
        clusters={gapClusters}
        gaps={gaps}
        draftCluster={draftCluster}
        loading={loading}
        flowLabels={flowLabels}
      />
      <GapPanel draftProposal={draftProposal} gaps={gaps} loading={loading} flowLabels={flowLabels} />
    </section>
  );
}
