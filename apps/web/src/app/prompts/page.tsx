"use client";

import { useConsole } from "../../components/ConsoleProvider";
import { PromptsPanel } from "../../components/PromptsPanel";

export default function PromptsPage() {
  const { prompts } = useConsole();

  return (
    <section className="workbench singlePane">
      <PromptsPanel prompts={prompts} />
    </section>
  );
}
