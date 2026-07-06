"use client";

import { useMemo } from "react";
import styled from "@emotion/styled";
import { Layer, Rectangle, ResponsiveContainer, Sankey, Tooltip } from "recharts";
import type { JourneySankey, JourneySegment } from "../../lib/types";

// Question-journey Sankey. Renders the { nodes, links } graph from
// /insights/journey as a Recharts <Sankey>: the path a question takes from being
// asked (and how confidently it was answered) through gaps, clusters, proposals,
// and merge/verification, with branch widths showing where volume leaks. The unit
// of flow shifts question → gap → proposal across the graph (see the caption); the
// API keeps each segment internally conserved.

// Muted per-segment palette, keyed to JourneySegment. Kept in-file (not the theme)
// because these four journey bands have no existing token; tones echo the other
// insights charts (blue trunk, amber gaps, teal proposals, violet verification).
const SEGMENT_COLOR: Record<JourneySegment, string> = {
  answer: "#4a7c93",
  gap: "#b7791f",
  proposal: "#2f855a",
  verify: "#6b46c1"
};

const Wrap = styled.div({
  display: "flex",
  flexDirection: "column",
  gap: "8px"
});

const Canvas = styled.div(({ theme }) => ({
  height: 380,
  borderRadius: theme.radius.md,
  border: `1px solid ${theme.color.border}`,
  background: "linear-gradient(135deg, #fafbf9 0%, #f5f7f2 100%)",
  overflow: "hidden"
}));

const Caption = styled.p(({ theme }) => ({
  margin: 0,
  fontSize: theme.font.size.xs,
  color: theme.color.textMuted
}));

const Empty = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  fontSize: theme.font.size.sm,
  color: theme.color.textMuted
}));

// The subset of Recharts' Sankey NodeProps this renderer reads. Structural, so
// Recharts' richer NodeProps is assignable to it without importing its types or
// casting. `sourceLinks` is empty for a terminal (right-edge) node, which decides
// which side of the bar the label sits on.
interface JourneyNodeShapeProps {
  x: number;
  y: number;
  width: number;
  height: number;
  index: number;
  payload: { name: string; sourceLinks: number[] };
}

// A journey node: a segment-coloured rectangle with its label outside the bar —
// to the left for terminal (sink) nodes, to the right otherwise, so labels never
// overlap the ribbons. The segment (hence colour) is looked up by node index from
// the caller's ordered node list, since Recharts' payload type omits our custom
// `segment` field.
function JourneyNodeShape(props: JourneyNodeShapeProps, segments: readonly JourneySegment[]) {
  const { x, y, width, height, index, payload } = props;
  const color = SEGMENT_COLOR[segments[index]] ?? SEGMENT_COLOR.answer;
  const isTerminal = payload.sourceLinks.length === 0;
  const labelX = isTerminal ? x - 6 : x + width + 6;
  const textAnchor = isTerminal ? "end" : "start";
  return (
    <Layer key={`journey-node-${index}`}>
      <Rectangle x={x} y={y} width={width} height={height} fill={color} fillOpacity={0.9} radius={2} />
      <text
        x={labelX}
        y={y + height / 2}
        textAnchor={textAnchor}
        dominantBaseline="middle"
        fontSize={11}
        fill="#3a423d"
      >
        {payload.name}
      </text>
    </Layer>
  );
}

// Map the API payload into Recharts' Sankey shape: nodes carry their label as
// `name`; links reference nodes by index, so the key→index lookup is built from
// the node order. `segments` mirrors the node order for the renderer's colouring.
function toSankeyData(journey: JourneySankey) {
  const index = new Map(journey.nodes.map((node, i) => [node.key, i]));
  const nodes = journey.nodes.map((node) => ({ name: node.label }));
  const segments = journey.nodes.map((node) => node.segment);
  const links = journey.links
    // Defensive: a link to a node that was pruned (no positive links) can't be
    // drawn. The API only emits referenced nodes, so this normally keeps every link.
    .filter((link) => index.has(link.source) && index.has(link.target))
    .map((link) => ({
      source: index.get(link.source) as number,
      target: index.get(link.target) as number,
      value: link.value
    }));
  return { nodes, links, segments };
}

export function QuestionJourneyChart({ journey }: { journey: JourneySankey }) {
  const data = useMemo(() => toSankeyData(journey), [journey]);

  // Recharts' Sankey layout divides by totals, so an empty graph would throw.
  // Render a placeholder instead (the ChartCard also gates emptiness upstream).
  if (data.links.length === 0) {
    return (
      <Canvas>
        <Empty>No question activity in the last 30 days yet.</Empty>
      </Canvas>
    );
  }

  return (
    <Wrap>
      <Canvas>
        <ResponsiveContainer width="100%" height="100%">
          <Sankey
            data={data}
            nodePadding={22}
            nodeWidth={12}
            margin={{ top: 12, right: 140, bottom: 12, left: 100 }}
            node={(nodeProps: JourneyNodeShapeProps) => JourneyNodeShape(nodeProps, data.segments)}
            link={{ stroke: "#c4cdc6", strokeOpacity: 0.5 }}
          >
            <Tooltip />
          </Sankey>
        </ResponsiveContainer>
      </Canvas>
      <Caption>
        Widths are counts. The unit shifts along the path — questions become gaps at &ldquo;Gaps raised&rdquo; (one
        question can raise several), and gaps become proposals at &ldquo;Proposals drafted&rdquo;. Each segment is
        internally consistent.
      </Caption>
    </Wrap>
  );
}
