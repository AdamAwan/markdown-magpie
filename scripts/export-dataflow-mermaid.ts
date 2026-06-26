import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDataFlowDiagram, FLOW_TABS } from "../apps/web/src/components/data-flow-diagrams";

const outputDir = join(process.cwd(), "apps", "web", "public", "dataflow", "mermaid");

mkdirSync(outputDir, { recursive: true });

for (const flow of FLOW_TABS) {
  const source = buildDataFlowDiagram(flow.key, {});
  writeFileSync(join(outputDir, `${flow.key}.mmd`), `${source}\n`, "utf8");
}
