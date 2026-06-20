"use client";

import { useConsole } from "../../components/ConsoleProvider";
import { ConfigPanel } from "../../components/ConfigPanel";
import { resolveApiUrl } from "../../lib/api";

export default function ConfigPage() {
  const { config, setConfig, showMessage, clearMessage } = useConsole();

  return (
    <section className="fullWorkbench">
      <ConfigPanel
        apiBaseUrl={resolveApiUrl("")}
        config={config}
        onConfigChange={setConfig}
        onMessage={(text, tone) => (text ? showMessage(text, tone) : clearMessage())}
      />
    </section>
  );
}
