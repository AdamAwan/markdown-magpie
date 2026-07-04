import { useEffect, useMemo, useRef, useState } from "react";
import styled from "@emotion/styled";
import * as Tooltip from "@radix-ui/react-tooltip";
import { JobCapability, JobState, JobType, JobView, ScheduleView, WatcherStatus, WatcherView } from "../lib/types";
import { formatJobType, isActiveJob } from "../lib/console";
import {
  Actions,
  Badge,
  Button,
  EmptyState,
  Field,
  IconButton,
  Select,
  Surface,
  statusTone
} from "./ui";

const JOB_STATES: JobState[] = ["created", "retry", "active", "completed", "cancelled", "failed", "blocked"];

// Rows per page in the jobs table. The API already caps the response, so this
// only pages what is loaded into the console.
const PAGE_SIZE = 20;

// Cancel is offered while a job is still in flight (created/retry/active); retry
// is offered only for a failed job. Both map to the broker endpoints the API
// exposes at /jobs/:id/cancel and /jobs/:id/retry.
const CANCELLABLE: ReadonlySet<JobState> = new Set<JobState>(["created", "retry", "active"]);

// The client-side capability→job-type map for the Workers panel pills. The browser
// deliberately does not bundle @magpie/jobs (zod + the job catalog), so this mirrors
// the catalog's AI_JOB_TYPES / capability routing by hand — keep it in sync with
// packages/jobs/src/catalog.ts. publish_proposal is served by github OR local-git.
const PROVIDER_JOB_TYPES = [
  "answer_question",
  "summarize_gap",
  "draft_markdown_proposal",
  "draft_seed_document",
  "outline_flow_seed",
  "fold_markdown_proposal",
  "detect_contradiction",
  "suggest_consolidation",
  "reconcile_gap_clusters",
  "sync_source_changes_generate_plan",
  "verify_document",
  "correct_document",
  "dedupe_documents",
  "split_document",
  "improve_document",
  "fold_changeset_proposal"
] as const satisfies readonly JobType[];

const CAPABILITY_JOB_TYPES = {
  "openai-compatible": PROVIDER_JOB_TYPES,
  "azure-openai": PROVIDER_JOB_TYPES,
  codex: PROVIDER_JOB_TYPES,
  claude: PROVIDER_JOB_TYPES,
  github: ["refresh_flow_snapshot", "publish_proposal", "crosslink_pull_requests", "comment_pull_request"],
  "local-git": ["publish_proposal"],
  maintenance: ["process_gaps_to_pull_requests", "source_change_sync", "correctness_patrol", "editorial_patrol", "verify_gap_closure"]
} as const satisfies Record<JobCapability, readonly JobType[]>;

const JobsPage = styled.section(({ theme }) => ({
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr)",
  gap: theme.space.lg
}));

const JobsLayout = styled(Surface.Body)({
  gap: "20px"
});

const JobFilters = styled.div(({ theme }) => ({
  display: "flex",
  flexWrap: "wrap",
  alignItems: "flex-end",
  gap: theme.space.lg,
  paddingBottom: theme.space.lg,
  "& > label": { minWidth: "180px" }
}));

const JobsWorkspace = styled.div(({ theme }) => ({
  display: "grid",
  gridTemplateColumns: "minmax(220px, 0.28fr) minmax(0, 1fr)",
  gap: theme.space.xl,
  minHeight: "560px",
  "@media (max-width: 960px)": { gridTemplateColumns: "1fr" }
}));

const JobsMaster = styled.div({
  display: "grid",
  alignContent: "start",
  minWidth: 0
});

const JobList = styled.nav(({ theme }) => ({
  display: "grid",
  alignContent: "start",
  minWidth: 0,
  gap: theme.space.md,
  maxHeight: "640px",
  overflow: "auto",
  borderRight: `1px solid ${theme.color.border}`,
  paddingRight: theme.space.lg,
  "@media (max-width: 960px)": {
    borderRight: 0,
    borderBottom: `1px solid ${theme.color.border}`,
    paddingRight: 0,
    paddingBottom: theme.space.lg
  }
}));

const JobListItem = styled.button<{ $selected: boolean }>(({ theme, $selected }) => ({
  display: "grid",
  gap: theme.space.sm,
  width: "100%",
  border: `1px solid ${$selected ? theme.color.accentBorder : theme.color.border}`,
  borderRadius: theme.radius.md,
  background: $selected ? theme.color.accentBg : theme.color.surface,
  color: theme.color.text,
  padding: `${theme.space.md} ${theme.space.lg}`,
  textAlign: "left",
  cursor: "pointer",
  font: "inherit",
  transition: "background 120ms ease, border-color 120ms ease",
  "&:hover": { background: $selected ? theme.color.accentBg : theme.color.surfaceMuted }
}));

const JobListTop = styled.span(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: theme.space.md,
  "& strong": {
    minWidth: 0,
    overflow: "hidden",
    fontSize: theme.font.size.md,
    fontWeight: theme.font.weight.semibold,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap"
  }
}));

const JobListMeta = styled.span(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-start",
  flexWrap: "wrap",
  gap: theme.space.md,
  color: theme.color.textMuted,
  fontFamily: theme.font.mono,
  fontSize: theme.font.size.xs
}));

const JobListPager = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: theme.space.sm,
  borderTop: `1px solid ${theme.color.border}`,
  paddingTop: theme.space.lg,
  marginRight: theme.space.lg,
  "@media (max-width: 960px)": { marginRight: 0 }
}));

const PagerStatus = styled.span(({ theme }) => ({
  color: theme.color.textMuted,
  fontSize: theme.font.size.sm
}));

const JobDetailPanel = styled.aside({
  display: "grid",
  alignContent: "start",
  minWidth: 0
});

const JobDetailRoot = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.lg
}));

const DetailTop = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: theme.space.lg
}));

const PathLine = styled.p(({ theme }) => ({
  color: theme.color.textMuted,
  fontFamily: theme.font.mono,
  fontSize: theme.font.size.sm
}));

const JobTimings = styled.dl(({ theme }) => ({
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
  gap: `${theme.space.sm} 18px`,
  margin: 0
}));

const ConfigRow = styled.div(({ theme }) => ({
  display: "grid",
  gridTemplateColumns: "minmax(130px, 0.42fr) minmax(0, 1fr)",
  gap: theme.space.md,
  alignItems: "start",
  borderTop: `1px solid ${theme.color.border}`,
  paddingTop: theme.space.md,
  "&:first-of-type": { borderTop: 0, paddingTop: 0 },
  "& dt": {
    color: theme.color.textMuted,
    fontSize: theme.font.size.sm,
    fontWeight: theme.font.weight.semibold
  },
  "& dd": {
    minWidth: 0,
    margin: 0,
    overflowWrap: "anywhere",
    color: theme.color.text,
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.sm
  }
}));

const JobError = styled.div({ margin: 0 });

const CrunchError = styled.p(({ theme }) => ({
  color: theme.color.dangerText,
  fontWeight: theme.font.weight.semibold
}));

const JobJson = styled.div(({ theme }) => ({
  "& pre": {
    margin: 0,
    overflowX: "auto",
    maxHeight: "280px",
    padding: `${theme.space.md} ${theme.space.lg}`,
    border: `1px solid ${theme.color.border}`,
    borderRadius: theme.radius.sm,
    background: theme.color.surface,
    fontSize: theme.font.size.sm
  }
}));

// Grid-based data table shared by the workers and schedules panels. Each variant
// sets its own column template via the classes on the head/row rows below.
const JobTable = styled.div({ display: "grid" });

const rowGrid = {
  display: "grid",
  gap: "12px",
  alignItems: "center"
} as const;

const TableHead = styled.div(({ theme }) => ({
  ...rowGrid,
  borderTop: `1px solid ${theme.color.border}`,
  padding: "10px 0",
  color: theme.color.textMuted,
  fontSize: theme.font.size.xs,
  fontWeight: theme.font.weight.semibold
}));

const TableRow = styled.div(({ theme }) => ({
  ...rowGrid,
  borderTop: `1px solid ${theme.color.border}`,
  padding: "10px 0",
  fontSize: theme.font.size.md
}));

const WorkerHead = styled(TableHead)({
  gridTemplateColumns:
    "minmax(180px, 1.2fr) 80px minmax(150px, 0.9fr) minmax(320px, 2fr) minmax(100px, 0.7fr) minmax(100px, 0.7fr)"
});

const WorkerRow = styled(TableRow)({
  gridTemplateColumns:
    "minmax(180px, 1.2fr) 80px minmax(150px, 0.9fr) minmax(320px, 2fr) minmax(100px, 0.7fr) minmax(100px, 0.7fr)",
  alignItems: "start"
});

const ScheduleHead = styled(TableHead)({
  gridTemplateColumns: "minmax(160px, 1.2fr) minmax(140px, 1fr) minmax(120px, 0.8fr) minmax(160px, 1fr)"
});

const ScheduleRow = styled(TableRow)({
  gridTemplateColumns: "minmax(160px, 1.2fr) minmax(140px, 1fr) minmax(120px, 0.8fr) minmax(160px, 1fr)"
});

const WorkerName = styled.span(({ theme }) => ({
  display: "inline-flex",
  flexDirection: "column",
  lineHeight: 1.3,
  "& .workerId": {
    color: theme.color.textSubtle,
    fontSize: theme.font.size.xs,
    fontFamily: theme.font.mono
  }
}));

const WorkerPills = styled.span(({ theme }) => ({
  display: "flex",
  flexWrap: "wrap",
  gap: theme.space.sm,
  alignItems: "flex-start"
}));

const WorkerPillsEmpty = styled.span(({ theme }) => ({
  color: theme.color.textSubtle
}));

// Non-interactive tag rendered inside a Tooltip.Trigger. A host `<span>` (not the
// Badge component) so Radix's `asChild` can attach its ref natively. `capability`
// reuses the pending/blue status palette, `jobType` the completed/green one.
const WorkerPill = styled.span<{ $variant: "capability" | "jobType" }>(({ theme, $variant }) => {
  const palette = $variant === "capability" ? theme.color.status.pending : theme.color.status.completed;
  return {
    display: "inline-flex",
    alignItems: "center",
    minHeight: "24px",
    padding: `3px ${theme.space.md}`,
    border: `1px solid ${palette.border}`,
    borderRadius: theme.radius.sm,
    background: palette.bg,
    color: palette.fg,
    fontFamily: $variant === "jobType" ? theme.font.mono : theme.font.sans,
    fontSize: theme.font.size.sm,
    fontWeight: theme.font.weight.semibold,
    whiteSpace: "nowrap",
    cursor: "default"
  };
});

const WorkerJob = styled.button(({ theme }) => ({
  border: 0,
  padding: 0,
  background: "none",
  color: theme.color.accent,
  font: "inherit",
  fontFamily: theme.font.mono,
  fontSize: theme.font.size.sm,
  textAlign: "left",
  cursor: "pointer",
  "&:hover": { textDecoration: "underline" }
}));

const WorkerTooltipContent = styled(Tooltip.Content)(({ theme }) => ({
  zIndex: 60,
  display: "grid",
  gap: theme.space.sm,
  maxWidth: "320px",
  border: `1px solid ${theme.color.primary}`,
  borderRadius: theme.radius.sm,
  background: theme.color.text,
  color: "#f3f6f1",
  padding: `${theme.space.md} ${theme.space.lg}`,
  fontSize: theme.font.size.sm,
  boxShadow: "0 8px 24px rgba(23, 33, 29, 0.28)"
}));

const WorkerTooltipName = styled.strong(({ theme }) => ({
  fontSize: theme.font.size.md,
  fontWeight: theme.font.weight.semibold
}));

const WorkerTooltipLead = styled.span({
  color: "#9fb1a7"
});

const WorkerTooltipList = styled.span({
  display: "flex",
  flexWrap: "wrap",
  gap: "4px 8px"
});

const WorkerTooltipItem = styled.span(({ theme }) => ({
  fontFamily: theme.font.mono
}));

const WorkerTooltipArrow = styled(Tooltip.Arrow)(({ theme }) => ({
  fill: theme.color.text
}));

export function JobsPanel({
  jobs,
  schedules,
  workers,
  selectedJob,
  onSelect,
  onClose,
  onCancel,
  onRetry,
  onAccept
}: {
  jobs: JobView[];
  schedules: ScheduleView[];
  workers: WatcherView[];
  selectedJob?: JobView;
  onSelect: (jobId: string) => void;
  onClose: () => void;
  onCancel: (jobId: string) => Promise<void>;
  onRetry: (jobId: string) => Promise<void>;
  onAccept: (jobIds: string[]) => Promise<void>;
}) {
  const [stateFilter, setStateFilter] = useState<JobState | "all">("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");

  const jobTypes = useMemo(
    () => Array.from(new Set(jobs.map((job) => job.type))).sort((a, b) => a.localeCompare(b)),
    [jobs]
  );

  const filtered = useMemo(
    () =>
      jobs
        .filter((job) => (stateFilter === "all" ? true : job.state === stateFilter))
        .filter((job) => (typeFilter === "all" ? true : job.type === typeFilter))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [jobs, stateFilter, typeFilter]
  );

  // The list grows without bound, so page the (already filtered + sorted) rows
  // client-side rather than rendering one ever-lengthening table.
  const [page, setPage] = useState(0);

  // Reset to the first page when the filters change so a narrowed list never
  // strands the user on a now-empty page.
  useEffect(() => {
    setPage(0);
  }, [stateFilter, typeFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  // Clamp instead of resetting: the 4s poll can shrink the list under the
  // current page, and clamping keeps the user on the last real page.
  const currentPage = Math.min(page, pageCount - 1);
  const visibleJobs = filtered.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE);
  const displayedJob = selectedJob ?? visibleJobs[0];

  const activeCount = jobs.filter(isActiveJob).length;
  const failedJobs = jobs.filter((job) => job.state === "failed" && !job.acceptedAt);
  const failedCount = failedJobs.length;
  const busyWorkerCount = workers.filter((worker) => worker.status === "busy").length;
  const activeScheduleCount = schedules.filter((schedule) => schedule.enabled).length;

  // On wide screens the detail sits in a sticky right rail and is already in
  // view; on narrow screens it stacks below the table. Bring it into view when a
  // *different* job is picked — keyed on the id, not the object, so the 4s poll
  // refreshing the selected job doesn't yank the viewport while the user reads.
  const detailRef = useRef<HTMLDivElement>(null);
  const selectedJobId = selectedJob?.id;
  useEffect(() => {
    if (selectedJobId) {
      detailRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [selectedJobId]);

  return (
    <JobsPage>
      <Surface>
        <Surface.Header>
          <h2>Jobs</h2>
          <Badge tone="neutral" title="Jobs loaded (most recent page)">
            {jobs.length}
          </Badge>
          {activeCount > 0 ? (
            <Badge tone="neutral" title="Jobs still in flight">
              {activeCount} active
            </Badge>
          ) : null}
          {failedCount > 0 ? (
            <Badge tone="failed" title="Failed jobs">
              {failedCount} failed
            </Badge>
          ) : null}
        </Surface.Header>
        <JobsLayout>
          <JobFilters>
            <Field label="State">
              <Select onChange={(event) => setStateFilter(event.target.value as JobState | "all")} value={stateFilter}>
                <option value="all">All states</option>
                {JOB_STATES.map((state) => (
                  <option key={state} value={state}>
                    {state}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Type">
              <Select onChange={(event) => setTypeFilter(event.target.value)} value={typeFilter}>
                <option value="all">All types</option>
                {jobTypes.map((type) => (
                  <option key={type} value={type}>
                    {formatJobType(type)}
                  </option>
                ))}
              </Select>
            </Field>
            <Badge tone="neutral" title="Jobs matching the current filters">
              {filtered.length} matched
            </Badge>
            {failedCount > 0 ? (
              <Button variant="secondary" onClick={() => void onAccept(failedJobs.map((job) => job.id))}>
                Accept all failures
              </Button>
            ) : null}
          </JobFilters>

          <JobsWorkspace>
            <JobsMaster>
              <JobList aria-label="Jobs">
                {visibleJobs.map((job) => (
                  <JobListItem
                    $selected={displayedJob?.id === job.id}
                    data-selected={displayedJob?.id === job.id ? "true" : undefined}
                    key={job.id}
                    onClick={() => onSelect(job.id)}
                  >
                    <JobListTop>
                      <strong title={job.type}>{formatJobType(job.type)}</strong>
                      <Badge
                        tone={job.acceptedAt ? "completed" : statusTone(job.state)}
                        dot
                        title={
                          job.acceptedAt
                            ? "Failure accepted " + new Date(job.acceptedAt).toLocaleString()
                            : "Job state: " + job.state
                        }
                      >
                        {job.acceptedAt ? "accepted" : job.state}
                      </Badge>
                    </JobListTop>
                    <JobListMeta>
                      <span title={`Retry ${job.retryCount} of ${job.retryLimit}`}>
                        {job.retryCount}/{job.retryLimit} attempts
                      </span>
                      <span title={new Date(job.createdAt).toLocaleString()}>{relativeAge(job.createdAt)} ago</span>
                      <span title={`Updated ${new Date(job.updatedAt).toLocaleString()}`}>updated</span>
                    </JobListMeta>
                  </JobListItem>
                ))}
                {filtered.length === 0 ? (
                  <EmptyState>
                    {jobs.length === 0 ? "No jobs queued." : "No jobs match the current filters."}
                  </EmptyState>
                ) : null}
              </JobList>

              {filtered.length > PAGE_SIZE ? (
                <JobListPager>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={currentPage === 0}
                    onClick={() => setPage(currentPage - 1)}
                  >
                    Previous
                  </Button>
                  <PagerStatus aria-live="polite">
                    {currentPage + 1}/{pageCount}
                  </PagerStatus>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={currentPage >= pageCount - 1}
                    onClick={() => setPage(currentPage + 1)}
                  >
                    Next
                  </Button>
                </JobListPager>
              ) : null}
            </JobsMaster>

            <JobDetailPanel ref={detailRef}>
              {displayedJob ? (
                <JobDetail
                  job={displayedJob}
                  onClose={selectedJob ? onClose : undefined}
                  onCancel={onCancel}
                  onRetry={onRetry}
                  onAccept={onAccept}
                />
              ) : (
                <EmptyState>Select a job to view its details.</EmptyState>
              )}
            </JobDetailPanel>
          </JobsWorkspace>
        </JobsLayout>
      </Surface>

      <Surface>
        <Surface.Header>
          <h2>Connected workers</h2>
          <Badge tone="neutral" title="Watchers connected (seen recently)">
            {workers.length} worker{workers.length === 1 ? "" : "s"}
          </Badge>
          {busyWorkerCount > 0 ? <Badge tone="neutral">{busyWorkerCount} busy</Badge> : null}
        </Surface.Header>
        <Surface.Body>
          <WorkersTable workers={workers} onSelect={onSelect} />
        </Surface.Body>
      </Surface>

      <Surface>
        <Surface.Header>
          <h2>Active schedules</h2>
          <Badge tone="neutral" title="Enabled schedules">
            {activeScheduleCount} active
          </Badge>
        </Surface.Header>
        <Surface.Body>
          <SchedulesTable schedules={schedules} />
        </Surface.Body>
      </Surface>
    </JobsPage>
  );
}

function JobDetail({
  job,
  onClose,
  onCancel,
  onRetry,
  onAccept
}: {
  job: JobView;
  onClose?: () => void;
  onCancel: (jobId: string) => Promise<void>;
  onRetry: (jobId: string) => Promise<void>;
  onAccept: (jobIds: string[]) => Promise<void>;
}) {
  return (
    <JobDetailRoot>
      <DetailTop>
        <div>
          <h3>{formatJobType(job.type)}</h3>
          <PathLine>
            <code>{job.id}</code> · {job.queueName}
          </PathLine>
        </div>
        <Actions>
          {CANCELLABLE.has(job.state) ? (
            <Button variant="secondary" onClick={() => void onCancel(job.id)}>
              Cancel
            </Button>
          ) : null}
          {job.state === "failed" ? (
            <Button variant="primary" onClick={() => void onRetry(job.id)}>
              Retry
            </Button>
          ) : null}
          {job.state === "failed" && !job.acceptedAt ? (
            <Button variant="secondary" onClick={() => void onAccept([job.id])}>
              Accept failure
            </Button>
          ) : null}
          {onClose ? (
            <IconButton label="Close details" size="sm" onClick={onClose}>
              ✕
            </IconButton>
          ) : null}
        </Actions>
      </DetailTop>

      <JobTimings>
        <Timing label="State" value={job.state} />
        <Timing label="Attempts" value={`${job.retryCount}/${job.retryLimit}`} />
        <Timing label="Created" value={fmt(job.createdAt)} />
        <Timing label="Started" value={fmt(job.startedAt)} />
        <Timing label="Completed" value={fmt(job.completedAt)} />
        <Timing label="Failed" value={fmt(job.failedAt)} />
        <Timing label="Accepted" value={fmt(job.acceptedAt)} />
        <Timing label="Cancelled" value={fmt(job.cancelledAt)} />
        <Timing label="Retry at" value={fmt(job.retryAt)} />
      </JobTimings>

      {job.error ? (
        <JobError>
          <h4>Error</h4>
          <CrunchError>
            [{job.error.category}] {job.error.code}: {job.error.message}
          </CrunchError>
        </JobError>
      ) : null}

      <JsonBlock title="Input" value={job.input} />
      {job.output !== undefined ? <JsonBlock title="Output" value={job.output} /> : null}
    </JobDetailRoot>
  );
}

// The watchers the API has heard from recently, with whether each is running a
// job (busy) or polling for one (idle). The clickable current-job id selects that
// job in the table above when it is on the loaded page.
function WorkersTable({ workers, onSelect }: { workers: WatcherView[]; onSelect: (jobId: string) => void }) {
  const sorted = useMemo(() => [...workers].sort((left, right) => left.name.localeCompare(right.name)), [workers]);

  return (
    <Tooltip.Provider delayDuration={150}>
      <JobTable>
        <WorkerHead>
          <span>Worker</span>
          <span>Status</span>
          <span>Capabilities</span>
          <span>Job types</span>
          <span>Current job</span>
          <span>Last seen</span>
        </WorkerHead>
        {sorted.map((worker) => {
          const { label, shortId } = splitWorkerName(worker.name);
          return (
            <WorkerRow key={worker.name}>
              <WorkerName title={worker.name}>
                <span>{label}</span>
                {shortId ? <span className="workerId">{shortId}</span> : null}
              </WorkerName>
              <span>
                <Badge tone={workerStatusTone(worker.status)} dot title={`Worker ${worker.status}`}>
                  {worker.status}
                </Badge>
              </span>
              <WorkerCapabilityPills capabilities={worker.capabilities} />
              <WorkerJobTypePills capabilities={worker.capabilities} />
              <span>
                {worker.currentJobId ? (
                  <WorkerJob
                    type="button"
                    onClick={() => onSelect(worker.currentJobId as string)}
                    title={worker.currentJobId}
                  >
                    {worker.currentJobId.slice(0, 8)}
                  </WorkerJob>
                ) : (
                  "—"
                )}
              </span>
              <span title={new Date(worker.lastSeenAt).toLocaleString()}>{relativeAge(worker.lastSeenAt)} ago</span>
            </WorkerRow>
          );
        })}
        {sorted.length === 0 ? (
          <EmptyState>No workers connected. Start a watcher to process queued jobs.</EmptyState>
        ) : null}
      </JobTable>
    </Tooltip.Provider>
  );
}

// Capability pills. Hovering a capability shows the job types it lets this
// worker run — the forward link ("what it can now do").
function WorkerCapabilityPills({ capabilities }: { capabilities: string[] }) {
  if (capabilities.length === 0) {
    return <WorkerPillsEmpty>—</WorkerPillsEmpty>;
  }

  return (
    <WorkerPills>
      {capabilities.map((capability) => {
        const jobTypes = isJobCapability(capability) ? CAPABILITY_JOB_TYPES[capability] : [];
        return (
          <Tooltip.Root key={capability}>
            <Tooltip.Trigger asChild>
              <WorkerPill $variant="capability">{capability}</WorkerPill>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <WorkerTooltipContent sideOffset={6} collisionPadding={12}>
                <WorkerTooltipName>{capability}</WorkerTooltipName>
                {jobTypes.length > 0 ? (
                  <>
                    <WorkerTooltipLead>
                      Runs {jobTypes.length} job type{jobTypes.length === 1 ? "" : "s"}:
                    </WorkerTooltipLead>
                    <WorkerTooltipList>
                      {jobTypes.map((type) => (
                        <WorkerTooltipItem key={type}>{formatJobType(type)}</WorkerTooltipItem>
                      ))}
                    </WorkerTooltipList>
                  </>
                ) : (
                  <WorkerTooltipLead>Unknown capability — no job types mapped.</WorkerTooltipLead>
                )}
                <WorkerTooltipArrow />
              </WorkerTooltipContent>
            </Tooltip.Portal>
          </Tooltip.Root>
        );
      })}
    </WorkerPills>
  );
}

// Job-type pills: the de-duplicated union of every job type this worker's
// capabilities can run. Hovering a job type shows which capability provides it —
// the reverse link ("how it can do this").
function WorkerJobTypePills({ capabilities }: { capabilities: string[] }) {
  const jobTypes = workerJobTypes(capabilities);
  if (jobTypes.length === 0) {
    return <WorkerPillsEmpty>—</WorkerPillsEmpty>;
  }

  return (
    <WorkerPills>
      {jobTypes.map((type) => {
        const providers = providersOf(type, capabilities);
        return (
          <Tooltip.Root key={type}>
            <Tooltip.Trigger asChild>
              <WorkerPill $variant="jobType">{formatJobType(type)}</WorkerPill>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <WorkerTooltipContent sideOffset={6} collisionPadding={12}>
                <WorkerTooltipName>{formatJobType(type)}</WorkerTooltipName>
                <WorkerTooltipLead>
                  {providers.length > 0
                    ? `Handled via the ${providers.join(", ")} capabilit${providers.length === 1 ? "y" : "ies"}.`
                    : "No matching capability."}
                </WorkerTooltipLead>
                <WorkerTooltipArrow />
              </WorkerTooltipContent>
            </Tooltip.Portal>
          </Tooltip.Root>
        );
      })}
    </WorkerPills>
  );
}

function isJobCapability(value: string): value is JobCapability {
  return Object.hasOwn(CAPABILITY_JOB_TYPES, value);
}

// Job types a worker can run, de-duplicated across its capabilities. The provider
// capabilities (codex/claude/openai-compatible/azure-openai) share one job-type
// list, so a worker usually has one provider capability plus github/maintenance.
function workerJobTypes(capabilities: string[]): JobType[] {
  const seen = new Set<JobType>();
  const result: JobType[] = [];
  for (const capability of capabilities) {
    if (!isJobCapability(capability)) {
      continue;
    }
    for (const type of CAPABILITY_JOB_TYPES[capability]) {
      if (!seen.has(type)) {
        seen.add(type);
        result.push(type);
      }
    }
  }
  return result;
}

// Which of the worker's capabilities provide a given job type — drives the
// reverse "how it can do this" tooltip on a job-type pill.
function providersOf(jobType: JobType, capabilities: string[]): string[] {
  return capabilities.filter(
    (capability) =>
      isJobCapability(capability) && (CAPABILITY_JOB_TYPES[capability] as readonly JobType[]).includes(jobType)
  );
}
// Maps the worker status to an existing status badge tone: busy reuses the amber
// "running" look, idle the green "available" look.
function workerStatusTone(status: WatcherStatus): "running" | "completed" {
  return status === "busy" ? "running" : "completed";
}

// Splits a watcher's unique name (`<label>-<uuid>`) into the operator-set label
// and a short id (first 8 hex of the uuid) for compact display. Names without a
// uuid suffix render whole, with no id chip.
const UUID_SUFFIX = /-([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function splitWorkerName(name: string): { label: string; shortId?: string } {
  const match = UUID_SUFFIX.exec(name);
  if (!match) {
    return { label: name };
  }
  const label = name.slice(0, match.index);
  return { label: label || name, shortId: match[1] };
}

function SchedulesTable({ schedules }: { schedules: ScheduleView[] }) {
  const active = schedules.filter((schedule) => schedule.enabled);

  return (
    <JobTable>
      <ScheduleHead>
        <span>Key</span>
        <span>Type</span>
        <span>Cron</span>
        <span>Next run</span>
      </ScheduleHead>
      {active.map((schedule) => (
        <ScheduleRow key={schedule.key}>
          <span title={schedule.key}>{schedule.key}</span>
          <span title={schedule.type}>{formatJobType(schedule.type)}</span>
          <span>
            <code>{schedule.cron}</code>
          </span>
          <span>{schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString() : "—"}</span>
        </ScheduleRow>
      ))}
      {active.length === 0 ? <EmptyState>No active schedules.</EmptyState> : null}
    </JobTable>
  );
}

function Timing({ label, value }: { label: string; value?: string }) {
  if (!value) {
    return null;
  }
  return (
    <ConfigRow>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </ConfigRow>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <JobJson>
      <h4>{title}</h4>
      <pre>{JSON.stringify(value ?? null, null, 2)}</pre>
    </JobJson>
  );
}

function fmt(value?: string): string | undefined {
  return value ? new Date(value).toLocaleString() : undefined;
}

// Compact "time since created" label for the table's Age column.
function relativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) {
    return "—";
  }
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
