"use client";

import "@xyflow/react/dist/style.css";
import { Workbench, Button, Row } from "../../components/ui";
import { ChartCard } from "../../components/insights/ChartCard";
import { GapBacklogChart } from "../../components/insights/GapBacklogChart";
import { GapFunnelChart } from "../../components/insights/GapFunnelChart";
import { useFunnel, useGapBacklog } from "../../components/insights/useInsights";

export default function InsightsPage() {
  const backlog = useGapBacklog();
  const funnel = useFunnel();

  // The endpoint zero-fills every day in the window, so a non-empty array can
  // still be "nothing happened". Treat all-zero transitions as empty.
  const backlogEmpty =
    !backlog.data ||
    backlog.data.length === 0 ||
    backlog.data.every((b) => b.opened + b.resolved + b.dismissed + b.parked === 0);

  // The funnel is empty when every stage is zero — no pipeline activity in the
  // window to visualise a drop-off for.
  const funnelEmpty = !funnel.data || funnel.data.length === 0 || funnel.data.every((s) => s.count === 0);

  const refreshing = backlog.loading || funnel.loading;

  return (
    <Workbench>
      <Row justify="end">
        <Button
          variant="secondary"
          disabled={refreshing}
          onClick={() => {
            backlog.refresh();
            funnel.refresh();
          }}
        >
          {refreshing ? "Refreshing" : "Refresh"}
        </Button>
      </Row>

      <ChartCard
        title="Gap-to-merge funnel"
        subtitle="How questions convert into merged, verified fixes — and where the drop-off is. Last 30 days."
        loading={funnel.loading}
        error={funnel.error}
        empty={funnelEmpty}
      >
        {funnel.data ? <GapFunnelChart stages={funnel.data} /> : null}
      </ChartCard>

      <ChartCard
        title="Open-gap backlog"
        subtitle="Gap lifecycle transitions per day, with the running net-open total. Last 30 days."
        loading={backlog.loading}
        error={backlog.error}
        empty={backlogEmpty}
      >
        {backlog.data ? <GapBacklogChart series={backlog.data} /> : null}
      </ChartCard>
    </Workbench>
  );
}
