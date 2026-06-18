"use client";

import { useMemo } from "react";
import { useConsole } from "../../components/ConsoleProvider";
import { GapClusterPanel, GapPanel } from "../../components/GapsPanel";
import { knowledgeFlowLabels } from "../../lib/config";

export default function GapsPage() {
  const { gapClusters, gaps, draftCluster, draftProposal, loading, config } = useConsole();

  const flowLabels = useMemo(() => knowledgeFlowLabels(config), [config]);

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
