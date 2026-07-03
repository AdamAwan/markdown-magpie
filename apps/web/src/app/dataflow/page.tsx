"use client";

import { useConsole } from "../../components/ConsoleProvider";
import { DataFlowPanel } from "../../components/DataFlowPanel";
import { Workbench } from "../../components/ui";

export default function DataFlowPage() {
  const { config } = useConsole();

  return (
    <Workbench>
      <DataFlowPanel config={config} />
    </Workbench>
  );
}
