"use client";

import { useConsole } from "../../components/ConsoleProvider";
import { DataFlowPanel } from "../../components/DataFlowPanel";

export default function DataFlowPage() {
  const { config } = useConsole();

  return (
    <section className="workbench singlePane">
      <DataFlowPanel config={config} />
    </section>
  );
}
