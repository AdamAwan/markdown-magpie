"use client";

import { useConsole } from "../../components/ConsoleProvider";
import { ProposalPanel } from "../../components/ProposalsPanel";
import { Workbench } from "../../components/ui";

export default function ProposalsPage() {
  const {
    loading,
    publishProposal,
    proposals,
    selectedProposal,
    setSelectedProposalId,
    updateProposalStatus,
    mergeProposal,
    rejectProposal
  } = useConsole();

  return (
    <Workbench>
      <ProposalPanel
        loading={loading}
        publishProposal={publishProposal}
        proposals={proposals}
        selectedProposal={selectedProposal}
        setSelectedProposalId={setSelectedProposalId}
        updateProposalStatus={updateProposalStatus}
        mergeProposal={mergeProposal}
        rejectProposal={rejectProposal}
      />
    </Workbench>
  );
}
