"use client";

import { useConsole } from "../../components/ConsoleProvider";
import { SourceMapPanel } from "../../components/SourceMapPanel";
import { Workbench } from "../../components/ui";

export default function SourceMapPage() {
  const { config, sourceMapEntries } = useConsole();

  return (
    <Workbench>
      <SourceMapPanel entries={sourceMapEntries} sources={config?.knowledge?.sources} />
    </Workbench>
  );
}
