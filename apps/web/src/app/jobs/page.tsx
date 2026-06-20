"use client";

import { useConsole } from "../../components/ConsoleProvider";
import { JobsPanel } from "../../components/JobsPanel";

export default function JobsPage() {
  const { jobs } = useConsole();

  return (
    <section className="fullWorkbench">
      <JobsPanel jobs={jobs} />
    </section>
  );
}
