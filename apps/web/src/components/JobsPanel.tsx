import { AiJob } from "../lib/types";

export function JobsPanel({ jobs }: { jobs: AiJob[] }) {
  return (
    <section className="surface">
      <div className="surfaceHeader">
        <h2>AI Jobs</h2>
        <span className="pill" title="Number of AI jobs loaded">
          {jobs.length}
        </span>
      </div>
      <div className="surfaceBody">
        <div className="jobTable">
          <div className="tableHead">
            <span>Type</span>
            <span>Status</span>
            <span>Worker</span>
            <span>Updated</span>
          </div>
          {[...jobs].slice(-12).reverse().map((job) => (
            <div className="tableRow" key={job.id}>
              <span>{job.type}</span>
              <span className={`status ${job.status}`} title={`Job status: ${job.status}`}>
                {job.status}
              </span>
              <span>{job.claimedBy ?? "unclaimed"}</span>
              <span>{new Date(job.updatedAt).toLocaleString()}</span>
            </div>
          ))}
          {jobs.length === 0 ? <p className="empty">No AI jobs queued.</p> : null}
        </div>
      </div>
    </section>
  );
}
