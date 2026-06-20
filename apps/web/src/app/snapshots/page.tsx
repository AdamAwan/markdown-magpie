"use client";

import { useConsole } from "../../components/ConsoleProvider";
import { SnapshotsPanel } from "../../components/SnapshotsPanel";

export default function SnapshotsPage() {
  const { flowSnapshots } = useConsole();

  return (
    <section className="workbench singlePane">
      <SnapshotsPanel snapshots={flowSnapshots} />
    </section>
  );
}
