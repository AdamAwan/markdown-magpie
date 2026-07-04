"use client";

import { useConsole } from "../../components/ConsoleProvider";
import { JobsPanel } from "../../components/JobsPanel";
import { Workbench } from "../../components/ui";

export default function JobsPage() {
  const {
    jobs,
    jobSchedules,
    workers,
    selectedJob,
    selectJob,
    clearSelectedJob,
    cancelJob,
    retryJob,
    acceptFailedJobs
  } = useConsole();

  return (
    <Workbench>
      <JobsPanel
        jobs={jobs}
        schedules={jobSchedules}
        workers={workers}
        selectedJob={selectedJob}
        onSelect={selectJob}
        onClose={clearSelectedJob}
        onCancel={cancelJob}
        onRetry={retryJob}
        onAccept={acceptFailedJobs}
      />
    </Workbench>
  );
}
