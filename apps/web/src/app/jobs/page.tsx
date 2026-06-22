"use client";

import { useConsole } from "../../components/ConsoleProvider";
import { JobsPanel } from "../../components/JobsPanel";

export default function JobsPage() {
  const { jobs, jobSchedules, workers, selectedJob, selectJob, cancelJob, retryJob, acceptFailedJobs } = useConsole();

  return (
    <section className="fullWorkbench">
      <JobsPanel
        jobs={jobs}
        schedules={jobSchedules}
        workers={workers}
        selectedJob={selectedJob}
        onSelect={selectJob}
        onCancel={cancelJob}
        onRetry={retryJob}
        onAccept={acceptFailedJobs}
      />
    </section>
  );
}
