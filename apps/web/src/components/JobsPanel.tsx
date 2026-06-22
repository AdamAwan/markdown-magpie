import { useMemo, useState } from "react";
import { JobState, JobView, ScheduleView } from "../lib/types";
import { formatJobType, isActiveJob } from "../lib/console";

const JOB_STATES: JobState[] = ["created", "retry", "active", "completed", "cancelled", "failed", "blocked"];

// Cancel is offered while a job is still in flight (created/retry/active); retry
// is offered only for a failed job. Both map to the broker endpoints the API
// exposes at /jobs/:id/cancel and /jobs/:id/retry.
const CANCELLABLE: ReadonlySet<JobState> = new Set<JobState>(["created", "retry", "active"]);

export function JobsPanel({
  jobs,
  schedules,
  selectedJob,
  onSelect,
  onCancel,
  onRetry
}: {
  jobs: JobView[];
  schedules: ScheduleView[];
  selectedJob?: JobView;
  onSelect: (jobId: string) => void;
  onCancel: (jobId: string) => Promise<void>;
  onRetry: (jobId: string) => Promise<void>;
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

  const activeCount = jobs.filter(isActiveJob).length;
  const failedCount = jobs.filter((job) => job.state === "failed").length;

  return (
    <section className="surface">
      <div className="surfaceHeader">
        <h2>Jobs</h2>
        <span className="pill" title="Jobs loaded (most recent page)">
          {jobs.length}
        </span>
        {activeCount > 0 ? <span className="pill" title="Jobs still in flight">{activeCount} active</span> : null}
        {failedCount > 0 ? <span className="status failed" title="Failed jobs">{failedCount} failed</span> : null}
      </div>
      <div className="surfaceBody">
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
            {filtered.length} shown
          </span>
        </div>

        <div className="jobTable">
          <div className="tableHead">
            <span>Type</span>
            <span>State</span>
            <span>Attempts</span>
            <span>Age</span>
            <span>Updated</span>
          </div>
          {filtered.map((job) => (
            <button
              className={selectedJob?.id === job.id ? "tableRow jobRow selected" : "tableRow jobRow"}
              key={job.id}
              onClick={() => onSelect(job.id)}
              type="button"
            >
              <span title={job.type}>{formatJobType(job.type)}</span>
              <span className={`status ${job.state}`} title={`Job state: ${job.state}`}>
                {job.state}
              </span>
              <span title={`Retry ${job.retryCount} of ${job.retryLimit}`}>
                {job.retryCount}/{job.retryLimit}
              </span>
              <span title={new Date(job.createdAt).toLocaleString()}>{relativeAge(job.createdAt)}</span>
              <span>{new Date(job.updatedAt).toLocaleString()}</span>
            </button>
          ))}
          {filtered.length === 0 ? (
            <p className="empty">{jobs.length === 0 ? "No jobs queued." : "No jobs match the current filters."}</p>
          ) : null}
        </div>

        {selectedJob ? (
          <JobDetail job={selectedJob} onCancel={onCancel} onRetry={onRetry} />
        ) : null}

        <SchedulesTable schedules={schedules} />
      </div>
    </section>
  );
}

function JobDetail({
  job,
  onCancel,
  onRetry
}: {
  job: JobView;
  onCancel: (jobId: string) => Promise<void>;
  onRetry: (jobId: string) => Promise<void>;
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
        </div>
      </div>

      <dl className="jobTimings">
        <Timing label="State" value={job.state} />
        <Timing label="Attempts" value={`${job.retryCount}/${job.retryLimit}`} />
        <Timing label="Created" value={fmt(job.createdAt)} />
        <Timing label="Started" value={fmt(job.startedAt)} />
        <Timing label="Completed" value={fmt(job.completedAt)} />
        <Timing label="Failed" value={fmt(job.failedAt)} />
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

function SchedulesTable({ schedules }: { schedules: ScheduleView[] }) {
  const active = schedules.filter((schedule) => schedule.enabled);

  return (
    <div className="jobSchedules">
      <h3 className="crunchSubhead">Active schedules</h3>
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
