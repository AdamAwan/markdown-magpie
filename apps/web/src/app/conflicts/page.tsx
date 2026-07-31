"use client";

import { SourceConflictsPanel } from "../../components/SourceConflictsPanel";
import { Workbench } from "../../components/ui";

export default function ConflictsPage() {
  return (
    <Workbench>
      <SourceConflictsPanel />
    </Workbench>
  );
}
