"use client";

import { ReconciliationsPanel } from "../../components/ReconciliationsPanel";
import { useConsole } from "../../components/ConsoleProvider";
import { Workbench } from "../../components/ui";

export default function ReconciliationsPage() {
  const { reconciliationDecisions } = useConsole();

  return (
    <Workbench>
      <ReconciliationsPanel decisions={reconciliationDecisions} />
    </Workbench>
  );
}
