"use client";

import { useConsole } from "../../components/ConsoleProvider";
import { GapClusterPanel, GapPanel } from "../../components/GapsPanel";

export default function GapsPage() {
  const { gapClusters, gaps, draftCluster, draftProposal, loading } = useConsole();

  return (
    <section className="workbench singlePane">
      <GapClusterPanel clusters={gapClusters} gaps={gaps} draftCluster={draftCluster} loading={loading} />
      <GapPanel draftProposal={draftProposal} gaps={gaps} loading={loading} />
    </section>
  );
}
