import { ConsoleSection } from "./types";

export interface SectionNav {
  section: ConsoleSection;
  path: string;
  glyph: string;
  label: string;
  // Sidebar grouping: entries sharing a group render together, with a divider
  // between groups. Entries are listed in display order.
  group: number;
}

// Single source of truth for the console's top-level sections: their URL paths
// and sidebar presentation. Routing, nav highlighting and the topbar title all
// derive the active section from the URL via this table.
export const SECTION_NAV: SectionNav[] = [
  { section: "ask", path: "/ask", glyph: "Q", label: "Ask", group: 1 },
  { section: "knowledge", path: "/knowledge", glyph: "K", label: "Knowledge", group: 1 },
  { section: "gaps", path: "/gaps", glyph: "G", label: "Gaps", group: 1 },
  { section: "seed", path: "/seed", glyph: "Se", label: "Seed", group: 1 },
  { section: "questionnaires", path: "/questionnaires", glyph: "Qn", label: "Questionnaires", group: 1 },
  { section: "proposals", path: "/proposals", glyph: "P", label: "Proposals", group: 1 },
  { section: "source-map", path: "/source-map", glyph: "Sm", label: "Source Map", group: 1 },
  { section: "jobs", path: "/jobs", glyph: "J", label: "Jobs", group: 2 },
  { section: "activity", path: "/activity", glyph: "A", label: "Activity", group: 2 },
  { section: "insights", path: "/insights", glyph: "I", label: "Insights", group: 2 },
  { section: "schedules", path: "/schedules", glyph: "Sc", label: "Schedules", group: 2 },
  { section: "config", path: "/config", glyph: "C", label: "Config", group: 2 },
  { section: "dataflow", path: "/dataflow", glyph: "D", label: "Data Flow", group: 3 },
  { section: "prompts", path: "/prompts", glyph: "Pr", label: "Prompts", group: 3 },
  { section: "mcp", path: "/mcp", glyph: "M", label: "Connect (MCP)", group: 3 }
];

const DEFAULT_SECTION: ConsoleSection = "ask";
export const DEFAULT_SECTION_PATH = "/ask";

export function sectionPath(section: ConsoleSection): string {
  return SECTION_NAV.find((entry) => entry.section === section)?.path ?? DEFAULT_SECTION_PATH;
}

// Resolve the active section from the URL. Detail routes nest under a section
// (e.g. /questionnaires/<id>), so match by longest path prefix rather than
// exact equality — otherwise a detail URL would fall through to the default
// section and mis-highlight the sidebar. A prefix must end at a path boundary
// so /source-map never captures a hypothetical /source sibling.
export function sectionFromPath(pathname: string): ConsoleSection {
  let best: SectionNav | undefined;
  for (const entry of SECTION_NAV) {
    if (pathname === entry.path || pathname.startsWith(`${entry.path}/`)) {
      if (!best || entry.path.length > best.path.length) {
        best = entry;
      }
    }
  }
  return best?.section ?? DEFAULT_SECTION;
}
