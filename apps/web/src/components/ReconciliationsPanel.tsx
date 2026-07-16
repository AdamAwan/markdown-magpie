import styled from "@emotion/styled";
import { ReconciliationDecision } from "../lib/types";
import { Badge, EmptyState, ListRow, Row, ScrollList, Surface, statusTone } from "./ui";

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

// Read-only history of the reconciler's clustering decisions: the proposing
// model's rationale for each merge/split and whether the critic confirmed and the
// reconciler applied it. Surfaces reasoning that previously lived only in logs.
export function ReconciliationsPanel({ decisions }: { decisions: ReconciliationDecision[] }) {
  return (
    <Surface>
      <Surface.Header>
        <h2>Reconciliations</h2>
        <Badge tone="neutral" title="Recent clustering decisions">
          {decisions.length}
        </Badge>
      </Surface.Header>
      <Surface.Body>
        <Hint>
          How the reconciler reshapes each flow&apos;s gap clusters: the model&apos;s rationale for a merge or split and
          whether the critic confirmed it. Only confirmed decisions are applied.
        </Hint>
        <ScrollList>
          {decisions.map((decision) => (
            <ListRow key={decision.id}>
              <Row justify="between" gap="lg">
                <h3 style={{ flex: 1, minWidth: 0 }}>
                  {decision.kind === "merge" ? "Merge" : "Split"} · {decision.flowId ?? "default"}
                </h3>
                <Row gap="md">
                  <Badge tone={statusTone(decision.confirmed ? "ready" : "rejected")} dot title="Critic verdict">
                    {decision.confirmed ? "confirmed" : "rejected"}
                  </Badge>
                  {decision.applied ? (
                    <Badge tone="completed" dot title="Applied to the flow's clusters">
                      applied
                    </Badge>
                  ) : null}
                </Row>
              </Row>
              <p>{decision.rationale}</p>
              <Path>
                {decision.clusterIds.length} cluster{decision.clusterIds.length === 1 ? "" : "s"} ·{" "}
                {new Date(decision.createdAt).toLocaleString()}
              </Path>
            </ListRow>
          ))}
          {decisions.length === 0 ? <EmptyState>No reconciliation decisions recorded yet.</EmptyState> : null}
        </ScrollList>
      </Surface.Body>
    </Surface>
  );
}
