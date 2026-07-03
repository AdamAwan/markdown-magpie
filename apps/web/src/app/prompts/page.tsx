"use client";

import { useConsole } from "../../components/ConsoleProvider";
import { PromptsPanel } from "../../components/PromptsPanel";
import { Workbench } from "../../components/ui";
import { knowledgeFlows } from "../../lib/config";

export default function PromptsPage() {
  const { prompts, config } = useConsole();

  return (
    <Workbench>
      <PromptsPanel prompts={prompts} flows={knowledgeFlows(config)} />
    </Workbench>
  );
}
