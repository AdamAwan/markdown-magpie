"use client";

import { useConsole } from "../../components/ConsoleProvider";
import { SnapshotsPanel } from "../../components/SnapshotsPanel";
import { Workbench } from "../../components/ui";

export default function SnapshotsPage() {
  const { flowSnapshots } = useConsole();

  return (
    <Workbench>
      <SnapshotsPanel snapshots={flowSnapshots} />
    </Workbench>
  );
}
