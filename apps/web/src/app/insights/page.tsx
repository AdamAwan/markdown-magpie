"use client";

import "@xyflow/react/dist/style.css";
import { Workbench, Button, Row } from "../../components/ui";
import { ChartCard } from "../../components/insights/ChartCard";
import { GapBacklogChart } from "../../components/insights/GapBacklogChart";
import { QuestionJourneyChart } from "../../components/insights/QuestionJourneyChart";
import { JobThroughputChart } from "../../components/insights/JobThroughputChart";
import { JobErrorBreakdownChart } from "../../components/insights/JobErrorBreakdownChart";
import { LatencyHistogramChart } from "../../components/insights/LatencyHistogramChart";
import { VerificationSuccessChart } from "../../components/insights/VerificationSuccessChart";
import { FeedbackChart } from "../../components/insights/FeedbackChart";
import { FreshnessChart } from "../../components/insights/FreshnessChart";
import { PatrolImpactChart } from "../../components/insights/PatrolImpactChart";
import { AiUsageChart } from "../../components/insights/AiUsageChart";
import {
  useAiUsage,
  useAnswerFeedback,
  useAnswerLatency,
  useFreshness,
  useJourney,
  useGapBacklog,
  useJobErrors,
  useJobThroughput,
  usePatrolImpact,
  useVerificationSuccess
} from "../../components/insights/useInsights";

export default function InsightsPage() {
  const backlog = useGapBacklog();
  const journey = useJourney();
  const throughput = useJobThroughput();
  const latency = useAnswerLatency();
  const verification = useVerificationSuccess();
  const feedback = useAnswerFeedback();
  const jobErrors = useJobErrors();
  const freshness = useFreshness();
  const patrols = usePatrolImpact();
  const aiUsage = useAiUsage();

  // The endpoint zero-fills every day in the window, so a non-empty array can
  // still be "nothing happened". Treat all-zero transitions as empty.
  const backlogEmpty =
    !backlog.data ||
    backlog.data.length === 0 ||
    backlog.data.every((b) => b.opened + b.resolved + b.dismissed + b.parked === 0);

  // The journey is empty when there are no positive-value links — no question
  // activity in the window to trace a path for.
  const journeyEmpty = !journey.data || journey.data.links.length === 0;

  const throughputEmpty =
    !throughput.data ||
    throughput.data.length === 0 ||
    throughput.data.every((b) => b.completed + b.failed + b.active + b.retry === 0);

  // The latency histogram always returns every fixed bin, so a non-empty array can
  // still be "no answers". Treat all-zero counts as empty.
  const latencyEmpty = !latency.data || latency.data.every((bin) => bin.count === 0);

  // Verification is empty until at least one closure check has run.
  const verificationEmpty =
    !verification.data || verification.data.totals.closed + verification.data.totals.stillOpen === 0;

  // Feedback is empty until at least one helpful/unhelpful verdict was given.
  const feedbackEmpty = !feedback.data || feedback.data.totals.helpful + feedback.data.totals.unhelpful === 0;

  // Job errors are empty until at least one job has failed in the window.
  const jobErrorsEmpty = !jobErrors.data || jobErrors.data.byCategory.length + jobErrors.data.byType.length === 0;

  // Freshness is a snapshot; empty only when there is nothing to classify.
  const freshnessEmpty =
    !freshness.data ||
    freshness.data.documents.fresh +
      freshness.data.documents.due +
      freshness.data.documents.overdue +
      freshness.data.sources.fresh +
      freshness.data.sources.stale ===
      0;

  // Patrols are empty until at least one maintenance run happened in the window.
  const patrolsEmpty = !patrols.data || patrols.data.length === 0;

  // AI usage is empty until at least one AI job completed in the window.
  const aiUsageEmpty = !aiUsage.data || aiUsage.data.length === 0;

  const refreshing =
    backlog.loading ||
    journey.loading ||
    throughput.loading ||
    latency.loading ||
    verification.loading ||
    feedback.loading ||
    jobErrors.loading ||
    freshness.loading ||
    patrols.loading ||
    aiUsage.loading;
  const refreshAll = () => {
    backlog.refresh();
    journey.refresh();
    throughput.refresh();
    latency.refresh();
    verification.refresh();
    feedback.refresh();
    jobErrors.refresh();
    freshness.refresh();
    patrols.refresh();
    aiUsage.refresh();
  };

  return (
    <Workbench>
      <Row justify="end">
        <Button variant="secondary" disabled={refreshing} onClick={refreshAll}>
          {refreshing ? "Refreshing" : "Refresh"}
        </Button>
      </Row>

      <ChartCard
        title="Question journey"
        subtitle="The path a question takes — answered by confidence, gaps, clusters, proposals, and verification — and where volume leaks at each branch. Last 30 days."
        loading={journey.loading}
        error={journey.error}
        empty={journeyEmpty}
        emptyMessage="No question activity in the last 30 days yet."
      >
        {journey.data ? <QuestionJourneyChart journey={journey.data} /> : null}
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

      <ChartCard
        title="Job throughput & health"
        subtitle="Queue jobs per day, stacked by state (completed/failed/active/retry). Last 30 days."
        loading={throughput.loading}
        error={throughput.error}
        empty={throughputEmpty}
      >
        {throughput.data ? <JobThroughputChart series={throughput.data} /> : null}
      </ChartCard>

      <ChartCard
        title="Answer latency"
        subtitle="Distribution of how long completed answers took, end to end. Last 30 days."
        loading={latency.loading}
        error={latency.error}
        empty={latencyEmpty}
        emptyMessage="No answers completed in the last 30 days yet."
      >
        {latency.data ? <LatencyHistogramChart bins={latency.data} /> : null}
      </ChartCard>

      <ChartCard
        title="Verification success"
        subtitle="Share of merged proposals whose gap-closure check confirmed the gap was closed. Last 30 days."
        loading={verification.loading}
        error={verification.error}
        empty={verificationEmpty}
        emptyMessage="No gap-closure verifications in the last 30 days yet."
      >
        {verification.data ? <VerificationSuccessChart totals={verification.data.totals} /> : null}
      </ChartCard>

      <ChartCard
        title="Answer feedback"
        subtitle="Helpful vs unhelpful verdicts per day and the unhelpful rate. Unhelpful on a confident answer is the strongest quality signal — it also raises a gap. Last 30 days."
        loading={feedback.loading}
        error={feedback.error}
        empty={feedbackEmpty}
        emptyMessage="No answer feedback in the last 30 days yet."
      >
        {feedback.data ? <FeedbackChart series={feedback.data.series} /> : null}
      </ChartCard>

      <ChartCard
        title="Job error breakdown"
        subtitle="Failed jobs grouped by error category and by job type. Last 30 days."
        loading={jobErrors.loading}
        error={jobErrors.error}
        empty={jobErrorsEmpty}
        emptyMessage="No jobs failed in the last 30 days."
      >
        {jobErrors.data ? (
          <JobErrorBreakdownChart byCategory={jobErrors.data.byCategory} byType={jobErrors.data.byType} />
        ) : null}
      </ChartCard>

      <ChartCard
        title="Knowledge-base freshness"
        subtitle="Active documents by review-cycle compliance, and synced sources by last-sync recency."
        loading={freshness.loading}
        error={freshness.error}
        empty={freshnessEmpty}
        emptyMessage="No documents with a review cycle, and no synced sources yet."
      >
        {freshness.data ? <FreshnessChart summary={freshness.data} /> : null}
      </ChartCard>

      <ChartCard
        title="Maintenance patrol impact"
        subtitle="Runs, findings, and proposals per maintenance task type. Last 30 days."
        loading={patrols.loading}
        error={patrols.error}
        empty={patrolsEmpty}
        emptyMessage="No maintenance runs in the last 30 days yet."
      >
        {patrols.data ? <PatrolImpactChart runs={patrols.data} /> : null}
      </ChartCard>

      <ChartCard
        title="AI token usage"
        subtitle="Provider-reported tokens per job type and provider, input and output stacked. CLI providers report no usage — their jobs show as unmetered, not free. Last 30 days."
        loading={aiUsage.loading}
        error={aiUsage.error}
        empty={aiUsageEmpty}
        emptyMessage="No AI jobs completed in the last 30 days yet."
      >
        {aiUsage.data ? <AiUsageChart usage={aiUsage.data} /> : null}
      </ChartCard>
    </Workbench>
  );
}
