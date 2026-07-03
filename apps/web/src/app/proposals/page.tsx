"use client";

import { useConsole } from "../../components/ConsoleProvider";
import { ProposalPanel } from "../../components/ProposalsPanel";

export default function ProposalsPage() {
  const {
    loading,
    publishProposal,
    proposals,
    selectedProposal,
    setSelectedProposalId,
    updateProposalStatus,
    mergeProposal
  } = useConsole();

  return (
    <section className="fullWorkbench">
      <ProposalPanel
        loading={loading}
        publishProposal={publishProposal}
        proposals={proposals}
        selectedProposal={selectedProposal}
        setSelectedProposalId={setSelectedProposalId}
        updateProposalStatus={updateProposalStatus}
        mergeProposal={mergeProposal}
      />
    </section>
  );
}
