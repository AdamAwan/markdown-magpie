"use client";

import { useConsole } from "../../components/ConsoleProvider";
import { PromptsPanel } from "../../components/PromptsPanel";
import { knowledgeFlows } from "../../lib/config";

export default function PromptsPage() {
  const { prompts, config } = useConsole();

  return (
    <section className="workbench singlePane">
      <PromptsPanel prompts={prompts} flows={knowledgeFlows(config)} />
    </section>
  );
}
