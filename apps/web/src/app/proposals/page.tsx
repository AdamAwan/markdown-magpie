"use client";

import { useMemo } from "react";
import { useConsole } from "../../components/ConsoleProvider";
import { ProposalPanel } from "../../components/ProposalsPanel";
import { Workbench } from "../../components/ui";
import { pendingPublishProposalIds } from "../../lib/console";

export default function ProposalsPage() {
  const {
    jobs,
    loading,
    publishProposal,
    proposals,
    selectedProposal,
    setSelectedProposalId,
    updateProposalStatus,
    mergeProposal,
    rejectProposal,
    bulkProposalAction
  } = useConsole();
  // Publish leaves the proposal `ready` until its job completes, so "already
  // publishing" comes from the 4s-polled jobs list, not the proposal record.
  const pendingPublishIds = useMemo(() => pendingPublishProposalIds(jobs), [jobs]);

  return (
    <Workbench>
      <ProposalPanel
        loading={loading}
        pendingPublishIds={pendingPublishIds}
        publishProposal={publishProposal}
        proposals={proposals}
        selectedProposal={selectedProposal}
        setSelectedProposalId={setSelectedProposalId}
        updateProposalStatus={updateProposalStatus}
        mergeProposal={mergeProposal}
        rejectProposal={rejectProposal}
        bulkProposalAction={bulkProposalAction}
      />
    </Workbench>
  );
}
