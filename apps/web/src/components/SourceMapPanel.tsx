import styled from "@emotion/styled";
import { ConfiguredKnowledgeRepository, SourceMapEntry } from "../lib/types";
import { Badge, ScrollList, Surface } from "./ui";

const SourceGroup = styled.div(({ theme }) => ({
  "&:not(:last-child)": {
    marginBottom: theme.space.xxl
  }
}));

const SourceGroupHead = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "baseline",
  gap: theme.space.md,
  marginBottom: theme.space.md,
  "& h3": {
    margin: 0,
    fontSize: theme.font.size.lg,
    fontWeight: theme.font.weight.semibold
  }
}));

const EntryRow = styled.div(({ theme }) => ({
  padding: `${theme.space.md} 0`,
  display: "grid",
  gap: theme.space.sm,
  "&:not(:last-child)": {
    borderBottom: `1px solid ${theme.color.border}`
  }
}));

const TopicRow = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: theme.space.md,
  "& h4": {
    margin: 0,
    fontSize: theme.font.size.base,
    fontWeight: theme.font.weight.semibold
  }
}));

const PathList = styled.div(({ theme }) => ({
  display: "flex",
  flexWrap: "wrap",
  gap: theme.space.xs
}));

const PathBadge = styled.span(({ theme }) => ({
  fontFamily: theme.font.mono,
  fontSize: theme.font.size.xs,
  padding: `2px ${theme.space.sm}`,
  background: theme.color.surfaceMuted,
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.sm,
  color: theme.color.textMuted
}));

const Description = styled.p(({ theme }) => ({
  margin: 0,
  fontSize: theme.font.size.sm,
  color: theme.color.textMuted,
  lineHeight: 1.4
}));

const Meta = styled.div(({ theme }) => ({
  display: "flex",
  gap: theme.space.lg,
  flexWrap: "wrap",
  fontSize: theme.font.size.xs,
  color: theme.color.textMuted
}));

const Empty = styled.div(({ theme }) => ({
  padding: theme.space.xxl,
  textAlign: "center",
  color: theme.color.textMuted
}));

function sourceLabel(
  sourceId: string,
  sources: ConfiguredKnowledgeRepository[] | undefined
): string {
  return sources?.find((source) => source.id === sourceId)?.name ?? sourceId;
}

export function SourceMapPanel({
  entries,
  sources
}: {
  entries: SourceMapEntry[];
  sources: ConfiguredKnowledgeRepository[] | undefined;
}) {
  if (entries.length === 0) {
    return (
      <Surface>
        <Surface.Header>
          <h2>Source Map</h2>
          <Badge tone="neutral">0</Badge>
        </Surface.Header>
        <Surface.Body>
          <Empty>
            No source-map entries yet. Agents contribute navigation hints as they
            explore source repositories for source-grounded drafting, verification,
            and improvement jobs. Entries appear here once at least one agent has
            reported a finding.
          </Empty>
        </Surface.Body>
      </Surface>
    );
  }

  const grouped = new Map<string, SourceMapEntry[]>();
  for (const entry of entries) {
    const group = grouped.get(entry.sourceId) ?? [];
    group.push(entry);
    grouped.set(entry.sourceId, group);
  }

  return (
    <Surface>
      <Surface.Header>
        <h2>Source Map</h2>
        <Badge tone="neutral">{entries.length}</Badge>
      </Surface.Header>
      <Surface.Body>
        <ScrollList>
          {[...grouped.entries()].map(([sourceId, sourceEntries]) => (
            <SourceGroup key={sourceId}>
              <SourceGroupHead>
                <h3>{sourceLabel(sourceId, sources)}</h3>
                <Badge tone="neutral">{sourceEntries.length}</Badge>
              </SourceGroupHead>
              {sourceEntries.map((entry) => (
                <EntryRow key={entry.id}>
                  <TopicRow>
                    <h4>{entry.topic}</h4>
                    {entry.observedSha ? (
                      <Badge tone="neutral">{entry.observedSha.slice(0, 7)}</Badge>
                    ) : null}
                  </TopicRow>
                  {entry.description ? (
                    <Description>{entry.description}</Description>
                  ) : null}
                  <PathList>
                    {entry.paths.map((path) => (
                      <PathBadge key={path}>{path}</PathBadge>
                    ))}
                  </PathList>
                  <Meta>
                    <span>
                      Updated {new Date(entry.updatedAt).toLocaleString()}
                    </span>
                    <span>
                      Created {new Date(entry.createdAt).toLocaleString()}
                    </span>
                  </Meta>
                </EntryRow>
              ))}
            </SourceGroup>
          ))}
        </ScrollList>
      </Surface.Body>
    </Surface>
  );
}
