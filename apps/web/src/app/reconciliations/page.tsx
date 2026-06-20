"use client";

import { ReconciliationsPanel } from "../../components/ReconciliationsPanel";
import { useConsole } from "../../components/ConsoleProvider";

export default function ReconciliationsPage() {
  const { reconciliationDecisions } = useConsole();

  return (
    <section className="workbench singlePane">
      <ReconciliationsPanel decisions={reconciliationDecisions} />
    </section>
  );
}
