"use client";

import { useConsole } from "../../components/ConsoleProvider";
import { ConfigPanel } from "../../components/ConfigPanel";
import { Workbench } from "../../components/ui";
import { resolveApiUrl } from "../../lib/api";

export default function ConfigPage() {
  const { config, setConfig, showMessage, clearMessage } = useConsole();

  return (
    <Workbench>
      <ConfigPanel
        apiBaseUrl={resolveApiUrl("")}
        config={config}
        onConfigChange={setConfig}
        onMessage={(text, tone) => (text ? showMessage(text, tone) : clearMessage())}
      />
    </Workbench>
  );
}
