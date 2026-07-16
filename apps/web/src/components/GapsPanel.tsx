import { useEffect, useMemo, useState } from "react";
import styled from "@emotion/styled";
import { GapCandidate, SuggestedGapCluster } from "../lib/types";
import { formatQuestionCount } from "../lib/format";
import { FlowTag } from "./common";
import { Badge, Chip, Row, ScrollList, Surface } from "./ui";

const NEW_CLUSTER = "__new__";

// A drafting hint shown when the reviewer has regrouped the clusters locally.
const Hint = styled.p(({ theme }) => ({
  margin: `0 0 ${theme.space.md}`,
  fontSize: theme.font.size.sm,
  color: theme.color.status.running.fg
}));

// A single editable cluster: a soft card that groups its gaps, distinct from the
// border-separated gap-candidate rows.
const ClusterCard = styled.article(({ theme }) => ({
  display: "grid",
  gap: theme.space.md,
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.card,
  background: theme.color.surfaceMuted,
  boxShadow: theme.shadow.card,
  padding: `${theme.space.xl} ${theme.space.xl}`
}));

const ClusterTitleInput = styled.input(({ theme }) => ({
  flex: 1,
  minWidth: 0,
  font: "inherit",
  fontSize: theme.font.size.lg,
  fontWeight: theme.font.weight.semibold,
  border: "1px solid transparent",
  borderRadius: theme.radius.sm,
  padding: `${theme.space.xs} ${theme.space.sm}`,
  background: "transparent",
  color: "inherit",
  "&:hover, &:focus": {
    borderColor: theme.color.border,
    background: theme.color.surface,
    outline: "none"
  }
}));

const ClusterRationale = styled.p(({ theme }) => ({
  margin: 0,
  fontSize: theme.font.size.md,
  lineHeight: 1.45,
  color: theme.color.textMuted
}));

const ClusterGaps = styled.ul(({ theme }) => ({
  margin: 0,
  padding: 0,
  listStyle: "none",
  display: "grid",
  gap: theme.space.sm,
  "& li": {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.space.lg,
    padding: `${theme.space.sm} ${theme.space.lg}`,
    border: `1px solid ${theme.color.border}`,
    borderRadius: theme.radius.md,
    background: theme.color.surface,
    fontSize: theme.font.size.md
  },
  "& li > span": {
    flex: 1,
    minWidth: 0
  }
}));

const MoveSelect = styled.select(({ theme }) => ({
  flex: "0 0 auto",
  width: "130px",
  fontSize: theme.font.size.sm,
  padding: `3px ${theme.space.sm}`,
  border: `1px solid ${theme.color.borderStrong}`,
  borderRadius: theme.radius.sm,
  background: theme.color.surface,
  color: theme.color.text
}));

const ClusterActions = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: theme.space.md
}));

// A single gap candidate: a divider-topped record block.
const GapRow = styled.article(({ theme }) => ({
  display: "grid",
  gap: theme.space.md,
  borderTop: `1px solid ${theme.color.border}`,
  padding: `${theme.space.lg} 0`,
  minWidth: 0,
  "&:first-of-type": { borderTop: 0 }
}));

const RowActions = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: theme.space.md,
  color: theme.color.textMuted,
  fontSize: theme.font.size.sm
}));

const EmptyLine = styled.p(({ theme }) => ({
  borderTop: `1px solid ${theme.color.border}`,
  paddingTop: theme.space.lg,
  color: theme.color.textMuted
}));

interface EditableCluster {
  id: string;
  title: string;
  summaries: string[];
  rationale?: string;
  flowId?: string;
}

function toEditableClusters(clusters: SuggestedGapCluster[]): EditableCluster[] {
  return clusters.map((cluster) => ({
    id: cluster.id,
    title: cluster.title,
    summaries: [...cluster.summaries],
    rationale: cluster.rationale,
    flowId: cluster.flowId
  }));
}

function clusterTitleFor(summary: string): string {
  const words = summary
    .replace(/[?.!]+$/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 8)
    .join(" ");
  return words || "Knowledge gap";
}

// Shows the semantic gap groupings as an editable starting point: the reviewer
// can move a gap into another cluster or split it into a new one, then draft a
// single proposal per cluster. Edits are local — the server suggestion is only a
// suggestion — and reset whenever a fresh suggestion arrives from the API.
export function GapClusterPanel({
  clusters,
  gaps,
  draftCluster,
  loading,
  flowLabels
}: {
  clusters: SuggestedGapCluster[];
  gaps: GapCandidate[];
  draftCluster: (summaries: string[], flowId?: string) => Promise<void>;
  loading: boolean;
  flowLabels: Record<string, string>;
}) {
  const signature = useMemo(
    () => clusters.map((cluster) => `${cluster.id}:${cluster.summaries.join("|")}`).join("~"),
    [clusters]
  );
  const [groups, setGroups] = useState<EditableCluster[]>(() => toEditableClusters(clusters));
  const [edited, setEdited] = useState(false);

  useEffect(() => {
    setGroups(toEditableClusters(clusters));
    setEdited(false);
    // Re-sync only when the server's suggestion actually changes, so a background
    // refresh does not wipe out an in-progress regrouping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  // Keyed by (flowId, summary): the same summary can exist in two flows with
  // different questions, so keying on summary alone would conflate their counts.
  const questionIdsByFlowSummary = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const gap of gaps) {
      map.set(`${gap.flowId ?? ""} ${gap.summary}`, gap.questionIds);
    }
    return map;
  }, [gaps]);

  function questionCount(summaries: string[], flowId?: string): number {
    const ids = new Set<string>();
    for (const summary of summaries) {
      for (const id of questionIdsByFlowSummary.get(`${flowId ?? ""} ${summary}`) ?? []) {
        ids.add(id);
      }
    }
    return ids.size;
  }

  function moveSummary(summary: string, targetId: string) {
    setEdited(true);
    setGroups((previous) => {
      // Dropping a gap from / adding it to a group invalidates that group's
      // suggested rationale, so clear it rather than show a stale explanation.
      let next = previous.map((group) =>
        group.summaries.includes(summary)
          ? { ...group, summaries: group.summaries.filter((item) => item !== summary), rationale: undefined }
          : group
      );
      if (targetId === NEW_CLUSTER) {
        // A split inherits the flow of the cluster the gap came from, so the new
        // group still drafts to the right destination.
        const sourceFlowId = previous.find((group) => group.summaries.includes(summary))?.flowId;
        next = [
          ...next,
          { id: `local-${summary}`, title: clusterTitleFor(summary), summaries: [summary], flowId: sourceFlowId }
        ];
      } else {
        next = next.map((group) =>
          group.id === targetId ? { ...group, summaries: [...group.summaries, summary], rationale: undefined } : group
        );
      }
      return next.filter((group) => group.summaries.length > 0);
    });
  }

  function renameGroup(id: string, title: string) {
    setEdited(true);
    setGroups((previous) => previous.map((group) => (group.id === id ? { ...group, title } : group)));
  }

  return (
    <Surface>
      <Surface.Header>
        <h2>Suggested Clusters</h2>
        <Badge tone="neutral" title="Gap clusters — one proposal each">
          {groups.length}
        </Badge>
      </Surface.Header>
      <Surface.Body>
        {edited ? (
          <Hint title="Your groupings override the original suggestion">Edited — drafting uses your groupings.</Hint>
        ) : null}
        <ScrollList>
          {groups.map((group) => (
            <ClusterCard key={group.id}>
              <Row gap="md">
                <ClusterTitleInput
                  value={group.title}
                  onChange={(event) => renameGroup(group.id, event.target.value)}
                  aria-label="Cluster title"
                />
                <FlowTag flowId={group.flowId} flowLabels={flowLabels} />
                <Badge
                  tone="neutral"
                  title={`${questionCount(group.summaries, group.flowId)} question(s) across ${group.summaries.length} gap(s)`}
                >
                  {group.summaries.length} gap{group.summaries.length === 1 ? "" : "s"}
                </Badge>
              </Row>
              {group.rationale ? (
                <ClusterRationale title="Why these gaps were grouped">{group.rationale}</ClusterRationale>
              ) : null}
              <ClusterGaps>
                {group.summaries.map((summary) => (
                  <li key={summary}>
                    <span>{summary}</span>
                    <MoveSelect
                      value=""
                      disabled={loading}
                      aria-label="Move gap to another cluster"
                      onChange={(event) => {
                        if (event.target.value) {
                          moveSummary(summary, event.target.value);
                        }
                      }}
                    >
                      <option value="">Move to…</option>
                      {groups
                        .filter((other) => other.id !== group.id)
                        .map((other) => (
                          <option key={other.id} value={other.id}>
                            {other.title}
                          </option>
                        ))}
                      <option value={NEW_CLUSTER}>New cluster</option>
                    </MoveSelect>
                  </li>
                ))}
              </ClusterGaps>
              <ClusterActions>
                <Chip
                  disabled={loading}
                  onClick={() => void draftCluster(group.summaries, group.flowId)}
                  title="Draft one proposal covering every gap in this cluster"
                  type="button"
                >
                  Draft Proposal
                </Chip>
              </ClusterActions>
            </ClusterCard>
          ))}
          {groups.length === 0 ? <EmptyLine>No gap clusters yet.</EmptyLine> : null}
        </ScrollList>
      </Surface.Body>
    </Surface>
  );
}

export function GapPanel({
  draftProposal,
  gaps,
  loading,
  flowLabels
}: {
  draftProposal: (gap: GapCandidate) => Promise<void>;
  gaps: GapCandidate[];
  loading: boolean;
  flowLabels: Record<string, string>;
}) {
  return (
    <Surface>
      <Surface.Header>
        <h2>Gap Candidates</h2>
        <Badge tone="neutral" title="Number of open gap candidates">
          {gaps.length}
        </Badge>
      </Surface.Header>
      <Surface.Body>
        <ScrollList>
          {gaps.map((gap) => (
            // The same summary can surface under two flows, so the flow is part
            // of the key to keep candidates distinct.
            <GapRow key={`${gap.flowId ?? ""} ${gap.summary}`}>
              <Row justify="between" gap="lg">
                <h3 style={{ flex: 1, minWidth: 0 }}>{gap.summary}</h3>
                <Row gap="md">
                  <FlowTag flowId={gap.flowId} flowLabels={flowLabels} />
                  <Badge
                    tone="neutral"
                    title={`${gap.count} question${gap.count === 1 ? "" : "s"} grouped into this gap`}
                  >
                    {formatQuestionCount(gap.count)}
                  </Badge>
                </Row>
              </Row>
              <p title="Question IDs grouped into this gap">{gap.questionIds.join(", ")}</p>
              <RowActions>
                <span title="Most recent matching question">{new Date(gap.latestAskedAt).toLocaleString()}</span>
                <Chip
                  disabled={loading}
                  onClick={() => void draftProposal(gap)}
                  title="Queue a job to draft Markdown for this knowledge gap"
                  type="button"
                >
                  Draft Proposal
                </Chip>
              </RowActions>
            </GapRow>
          ))}
          {gaps.length === 0 ? <EmptyLine>No gap candidates yet.</EmptyLine> : null}
        </ScrollList>
      </Surface.Body>
    </Surface>
  );
}
