"use client";

import { useConsole } from "../../components/ConsoleProvider";
import { JobsPanel } from "../../components/JobsPanel";

export default function JobsPage() {
  const { jobs, jobSchedules, selectedJob, selectJob, cancelJob, retryJob } = useConsole();

  return (
    <section className="fullWorkbench">
      <JobsPanel
        jobs={jobs}
        schedules={jobSchedules}
        selectedJob={selectedJob}
        onSelect={selectJob}
        onCancel={cancelJob}
        onRetry={retryJob}
      />
    </section>
  );
}
