import styled from "@emotion/styled";
import { FlowSnapshot } from "../lib/types";
import { Badge, EmptyState, ScrollList, ListRow, Row, Surface, statusTone } from "./ui";

const Hint = styled.p(({ theme }) => ({
  margin: `0 0 ${theme.space.md}`,
  fontSize: theme.font.size.sm,
  color: theme.color.status.running.fg
}));

const Path = styled.p(({ theme }) => ({
  color: theme.color.textMuted,
  fontFamily: theme.font.mono,
  fontSize: theme.font.size.sm
}));

const ProposalPath = styled.small(({ theme }) => ({
  color: theme.color.textMuted,
  fontFamily: theme.font.mono,
  fontSize: theme.font.size.sm
}));

const ProposalList = styled.ul(({ theme }) => ({
  margin: 0,
  padding: 0,
  listStyle: "none",
  display: "grid",
  gap: theme.space.sm
}));

// Read-only view of each flow's downloaded snapshot: the gaps, in-flight
// proposals, and polled pull-request state the fetch job assembled and the
// reconciler reads instead of polling the host live.
export function SnapshotsPanel({ snapshots }: { snapshots: FlowSnapshot[] }) {
  return (
    <Surface>
      <Surface.Header>
        <h2>Snapshots</h2>
        <Badge tone="neutral" title="Flows with a downloaded snapshot">
          {snapshots.length}
        </Badge>
      </Surface.Header>
      <Surface.Body>
        <Hint>
          Per-flow data the fetch job downloads — gaps, in-flight proposals, and polled pull-request state.
          The reconciler reads this instead of calling the host during reconciliation.
        </Hint>
        <ScrollList>
          {snapshots.map((snapshot) => (
            <ListRow key={snapshot.flowId ?? "default"}>
              <Row justify="between" gap="lg">
                <h3 style={{ flex: 1, minWidth: 0 }}>{snapshot.flowName}</h3>
                <Row gap="md">
                  <Badge tone="neutral" title="Gaps captured">{snapshot.gaps.length} gaps</Badge>
                  <Badge tone="neutral" title="In-flight proposals">{snapshot.proposals.length} proposals</Badge>
                  <Badge tone="neutral" title="Open pull requests polled">{snapshot.pullRequests.length} PRs</Badge>
                </Row>
              </Row>
              <Path>
                Taken {new Date(snapshot.takenAt).toLocaleString()} · catalog revision {snapshot.catalogRevision}
              </Path>
              {snapshot.proposals.length > 0 ? (
                <ProposalList>
                  {snapshot.proposals.map((proposal) => {
                    const pr = snapshot.pullRequests.find((entry) => entry.proposalId === proposal.id);
                    return (
                      <li key={proposal.id}>
                        <Badge tone={statusTone(proposal.status)} dot title={`Proposal status: ${proposal.status}`}>
                          {proposal.status}
                        </Badge>{" "}
                        {proposal.title ?? proposal.id}
                        {pr ? (
                          <ProposalPath>
                            {" "}
                            — PR {pr.state}
                            {pr.merged ? " (merged)" : ""}
                          </ProposalPath>
                        ) : null}
                      </li>
                    );
                  })}
                </ProposalList>
              ) : null}
            </ListRow>
          ))}
          {snapshots.length === 0 ? (
            <EmptyState>No snapshots yet. They appear once a flow&apos;s fetch job has run.</EmptyState>
          ) : null}
        </ScrollList>
      </Surface.Body>
    </Surface>
  );
}
