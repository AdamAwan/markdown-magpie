"use client";

import { Workbench, Button, Row } from "../../components/ui";
import { ChartCard } from "../../components/insights/ChartCard";
import { GapBacklogChart } from "../../components/insights/GapBacklogChart";
import { useGapBacklog } from "../../components/insights/useInsights";

export default function InsightsPage() {
  const backlog = useGapBacklog();

  // The endpoint zero-fills every day in the window, so a non-empty array can
  // still be "nothing happened". Treat all-zero transitions as empty.
  const backlogEmpty =
    !backlog.data ||
    backlog.data.length === 0 ||
    backlog.data.every((b) => b.opened + b.resolved + b.dismissed + b.parked === 0);

  return (
    <Workbench>
      <Row justify="end">
        <Button
          variant="secondary"
          disabled={backlog.loading}
          onClick={() => backlog.refresh()}
        >
          {backlog.loading ? "Refreshing" : "Refresh"}
        </Button>
      </Row>

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
