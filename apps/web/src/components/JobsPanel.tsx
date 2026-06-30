import { useEffect, useMemo, useRef, useState } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { JobCapability, JobState, JobType, JobView, ScheduleView, WatcherStatus, WatcherView } from "../lib/types";
import { formatJobType, isActiveJob } from "../lib/console";

const JOB_STATES: JobState[] = ["created", "retry", "active", "completed", "cancelled", "failed", "blocked"];

// Rows per page in the jobs table. The API already caps the response, so this
// only pages what is loaded into the console.
const PAGE_SIZE = 20;

// Cancel is offered while a job is still in flight (created/retry/active); retry
// is offered only for a failed job. Both map to the broker endpoints the API
// exposes at /jobs/:id/cancel and /jobs/:id/retry.
const CANCELLABLE: ReadonlySet<JobState> = new Set<JobState>(["created", "retry", "active"]);

const PROVIDER_JOB_TYPES = [
  "answer_question",
  "summarize_gap",
  "draft_markdown_proposal",
  "detect_contradiction",
  "suggest_consolidation",
  "cluster_gap_candidates",
  "reconcile_gap_clusters",
  "sync_source_changes_generate_plan"
] as const satisfies readonly JobType[];

const CAPABILITY_JOB_TYPES = {
  "openai-compatible": PROVIDER_JOB_TYPES,
  "azure-openai": PROVIDER_JOB_TYPES,
  codex: PROVIDER_JOB_TYPES,
  claude: PROVIDER_JOB_TYPES,
  github: ["refresh_flow_snapshot", "publish_proposal", "crosslink_pull_requests", "comment_pull_request"],
  maintenance: ["process_gaps_to_pull_requests", "source_change_sync", "correctness_patrol", "editorial_patrol"]
} as const satisfies Record<JobCapability, readonly JobType[]>;

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
    <section className="jobsPage">
      <section className="surface">
        <div className="surfaceHeader">
          <h2>Jobs</h2>
          <span className="pill" title="Jobs loaded (most recent page)">
            {jobs.length}
          </span>
          {activeCount > 0 ? (
            <span className="pill" title="Jobs still in flight">
              {activeCount} active
            </span>
          ) : null}
          {failedCount > 0 ? (
            <span className="status failed" title="Failed jobs">
              {failedCount} failed
            </span>
          ) : null}
        </div>
        <div className="surfaceBody jobsLayout">
          <div className="jobFilters">
            <label className="field">
              <span>State</span>
              <select onChange={(event) => setStateFilter(event.target.value as JobState | "all")} value={stateFilter}>
                <option value="all">All states</option>
                {JOB_STATES.map((state) => (
                  <option key={state} value={state}>
                    {state}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Type</span>
              <select onChange={(event) => setTypeFilter(event.target.value)} value={typeFilter}>
                <option value="all">All types</option>
                {jobTypes.map((type) => (
                  <option key={type} value={type}>
                    {formatJobType(type)}
                  </option>
                ))}
              </select>
            </label>
            <span className="pill" title="Jobs matching the current filters">
              {filtered.length} matched
            </span>
            {failedCount > 0 ? (
              <button
                className="button secondary"
                onClick={() => void onAccept(failedJobs.map((job) => job.id))}
                type="button"
              >
                Accept all failures
              </button>
            ) : null}
          </div>

          <div className="jobsWorkspace">
            <div className="jobsMaster">
              <nav className="jobList" aria-label="Jobs">
                {visibleJobs.map((job) => (
                  <button
                    className={displayedJob?.id === job.id ? "jobListItem selected" : "jobListItem"}
                    key={job.id}
                    onClick={() => onSelect(job.id)}
                    type="button"
                  >
                    <span className="jobListTop">
                      <strong title={job.type}>{formatJobType(job.type)}</strong>
                      <span
                        className={"status " + (job.acceptedAt ? "ready" : job.state)}
                        title={
                          job.acceptedAt
                            ? "Failure accepted " + new Date(job.acceptedAt).toLocaleString()
                            : "Job state: " + job.state
                        }
                      >
                        {job.acceptedAt ? "accepted" : job.state}
                      </span>
                    </span>
                    <span className="jobListMeta">
                      <span title={`Retry ${job.retryCount} of ${job.retryLimit}`}>
                        {job.retryCount}/{job.retryLimit} attempts
                      </span>
                      <span title={new Date(job.createdAt).toLocaleString()}>{relativeAge(job.createdAt)} ago</span>
                      <span title={`Updated ${new Date(job.updatedAt).toLocaleString()}`}>updated</span>
                    </span>
                  </button>
                ))}
                {filtered.length === 0 ? (
                  <p className="empty">
                    {jobs.length === 0 ? "No jobs queued." : "No jobs match the current filters."}
                  </p>
                ) : null}
              </nav>

              {filtered.length > PAGE_SIZE ? (
                <div className="tablePager jobListPager">
                  <button
                    className="button secondary"
                    disabled={currentPage === 0}
                    onClick={() => setPage(currentPage - 1)}
                    type="button"
                  >
                    Previous
                  </button>
                  <span className="pagerStatus" aria-live="polite">
                    {currentPage + 1}/{pageCount}
                  </span>
                  <button
                    className="button secondary"
                    disabled={currentPage >= pageCount - 1}
                    onClick={() => setPage(currentPage + 1)}
                    type="button"
                  >
                    Next
                  </button>
                </div>
              ) : null}
            </div>

            <aside className="jobDetailPanel" ref={detailRef}>
              {displayedJob ? (
                <JobDetail
                  job={displayedJob}
                  onClose={selectedJob ? onClose : undefined}
                  onCancel={onCancel}
                  onRetry={onRetry}
                  onAccept={onAccept}
                />
              ) : (
                <p className="empty">Select a job to view its details.</p>
              )}
            </aside>
          </div>
        </div>
      </section>

      <section className="surface">
        <div className="surfaceHeader">
          <h2>Connected workers</h2>
          <span className="pill" title="Watchers connected (seen recently)">
            {workers.length} worker{workers.length === 1 ? "" : "s"}
          </span>
          {busyWorkerCount > 0 ? <span className="pill">{busyWorkerCount} busy</span> : null}
        </div>
        <div className="surfaceBody">
          <WorkersTable workers={workers} onSelect={onSelect} />
        </div>
      </section>

      <section className="surface">
        <div className="surfaceHeader">
          <h2>Active schedules</h2>
          <span className="pill" title="Enabled schedules">
            {activeScheduleCount} active
          </span>
        </div>
        <div className="surfaceBody">
          <SchedulesTable schedules={schedules} />
        </div>
      </section>
    </section>
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
    <div className="jobDetail">
      <div className="rowTop">
        <div>
          <h3>{formatJobType(job.type)}</h3>
          <p className="path">
            <code>{job.id}</code> · {job.queueName}
          </p>
        </div>
        <div className="rowActions">
          {CANCELLABLE.has(job.state) ? (
            <button className="button secondary" onClick={() => void onCancel(job.id)} type="button">
              Cancel
            </button>
          ) : null}
          {job.state === "failed" ? (
            <button className="button" onClick={() => void onRetry(job.id)} type="button">
              Retry
            </button>
          ) : null}
          {job.state === "failed" && !job.acceptedAt ? (
            <button className="button secondary" onClick={() => void onAccept([job.id])} type="button">
              Accept failure
            </button>
          ) : null}
          {onClose ? (
            <button aria-label="Close details" className="jobDetailClose" onClick={onClose} title="Close" type="button">
              ✕
            </button>
          ) : null}
        </div>
      </div>

      <dl className="jobTimings">
        <Timing label="State" value={job.state} />
        <Timing label="Attempts" value={`${job.retryCount}/${job.retryLimit}`} />
        <Timing label="Created" value={fmt(job.createdAt)} />
        <Timing label="Started" value={fmt(job.startedAt)} />
        <Timing label="Completed" value={fmt(job.completedAt)} />
        <Timing label="Failed" value={fmt(job.failedAt)} />
        <Timing label="Accepted" value={fmt(job.acceptedAt)} />
        <Timing label="Cancelled" value={fmt(job.cancelledAt)} />
        <Timing label="Retry at" value={fmt(job.retryAt)} />
      </dl>

      {job.error ? (
        <div className="jobError">
          <h4>Error</h4>
          <p className="crunchError">
            [{job.error.category}] {job.error.code}: {job.error.message}
          </p>
        </div>
      ) : null}

      <JsonBlock title="Input" value={job.input} />
      {job.output !== undefined ? <JsonBlock title="Output" value={job.output} /> : null}
    </div>
  );
}

// The watchers the API has heard from recently, with whether each is running a
// job (busy) or polling for one (idle). The clickable current-job id selects that
// job in the table above when it is on the loaded page.
function WorkersTable({ workers, onSelect }: { workers: WatcherView[]; onSelect: (jobId: string) => void }) {
  const sorted = useMemo(() => [...workers].sort((left, right) => left.name.localeCompare(right.name)), [workers]);

  return (
    <Tooltip.Provider delayDuration={150}>
      <div className="jobTable">
        <div className="tableHead workerHead">
          <span>Worker</span>
          <span>Status</span>
          <span>Capabilities</span>
          <span>Job types</span>
          <span>Current job</span>
          <span>Last seen</span>
        </div>
        {sorted.map((worker) => {
          const { label, shortId } = splitWorkerName(worker.name);
          return (
            <div className="tableRow workerRow" key={worker.name}>
              <span className="workerName" title={worker.name}>
                <span>{label}</span>
                {shortId ? <span className="workerId">{shortId}</span> : null}
              </span>
              <span className={`status ${workerStatusClass(worker.status)}`} title={`Worker ${worker.status}`}>
                {worker.status}
              </span>
              <WorkerCapabilityPills capabilities={worker.capabilities} />
              <WorkerJobTypePills capabilities={worker.capabilities} />
              <span>
                {worker.currentJobId ? (
                  <button
                    className="workerJob"
                    onClick={() => onSelect(worker.currentJobId as string)}
                    title={worker.currentJobId}
                    type="button"
                  >
                    {worker.currentJobId.slice(0, 8)}
                  </button>
                ) : (
                  "—"
                )}
              </span>
              <span title={new Date(worker.lastSeenAt).toLocaleString()}>{relativeAge(worker.lastSeenAt)} ago</span>
            </div>
          );
        })}
        {sorted.length === 0 ? (
          <p className="empty">No workers connected. Start a watcher to process queued jobs.</p>
        ) : null}
      </div>
    </Tooltip.Provider>
  );
}

// Capability pills. Hovering a capability shows the job types it lets this
// worker run — the forward link ("what it can now do").
function WorkerCapabilityPills({ capabilities }: { capabilities: string[] }) {
  if (capabilities.length === 0) {
    return <span className="workerPillsEmpty">—</span>;
  }

  return (
    <span className="workerPills">
      {capabilities.map((capability) => {
        const jobTypes = isJobCapability(capability) ? CAPABILITY_JOB_TYPES[capability] : [];
        return (
          <Tooltip.Root key={capability}>
            <Tooltip.Trigger asChild>
              <span className="pill workerPill capabilityPill">{capability}</span>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content className="workerTooltip" sideOffset={6} collisionPadding={12}>
                <strong className="workerTooltipName">{capability}</strong>
                {jobTypes.length > 0 ? (
                  <>
                    <span className="workerTooltipLead">
                      Runs {jobTypes.length} job type{jobTypes.length === 1 ? "" : "s"}:
                    </span>
                    <span className="workerTooltipList">
                      {jobTypes.map((type) => (
                        <span className="workerTooltipItem" key={type}>
                          {formatJobType(type)}
                        </span>
                      ))}
                    </span>
                  </>
                ) : (
                  <span className="workerTooltipLead">Unknown capability — no job types mapped.</span>
                )}
                <Tooltip.Arrow className="workerTooltipArrow" />
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        );
      })}
    </span>
  );
}

// Job-type pills: the de-duplicated union of every job type this worker's
// capabilities can run. Hovering a job type shows which capability provides it —
// the reverse link ("how it can do this").
function WorkerJobTypePills({ capabilities }: { capabilities: string[] }) {
  const jobTypes = workerJobTypes(capabilities);
  if (jobTypes.length === 0) {
    return <span className="workerPillsEmpty">—</span>;
  }

  return (
    <span className="workerPills">
      {jobTypes.map((type) => {
        const providers = providersOf(type, capabilities);
        return (
          <Tooltip.Root key={type}>
            <Tooltip.Trigger asChild>
              <span className="pill workerPill jobTypePill">{formatJobType(type)}</span>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content className="workerTooltip" sideOffset={6} collisionPadding={12}>
                <strong className="workerTooltipName">{formatJobType(type)}</strong>
                <span className="workerTooltipLead">
                  {providers.length > 0
                    ? `Handled via the ${providers.join(", ")} capabilit${providers.length === 1 ? "y" : "ies"}.`
                    : "No matching capability."}
                </span>
                <Tooltip.Arrow className="workerTooltipArrow" />
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        );
      })}
    </span>
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
// Maps the worker status to an existing status-pill colour: busy reuses the amber
// "running" look, idle the green "available" look.
function workerStatusClass(status: WatcherStatus): string {
  return status === "busy" ? "running" : "ready";
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
    <div className="jobTable">
      <div className="tableHead scheduleHead">
        <span>Key</span>
        <span>Type</span>
        <span>Cron</span>
        <span>Next run</span>
      </div>
      {active.map((schedule) => (
        <div className="tableRow scheduleRow" key={schedule.key}>
          <span title={schedule.key}>{schedule.key}</span>
          <span title={schedule.type}>{formatJobType(schedule.type)}</span>
          <span>
            <code>{schedule.cron}</code>
          </span>
          <span>{schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString() : "—"}</span>
        </div>
      ))}
      {active.length === 0 ? <p className="empty">No active schedules.</p> : null}
    </div>
  );
}

function Timing({ label, value }: { label: string; value?: string }) {
  if (!value) {
    return null;
  }
  return (
    <div className="configRow">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="jobJson">
      <h4>{title}</h4>
      <pre>{JSON.stringify(value ?? null, null, 2)}</pre>
    </div>
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
