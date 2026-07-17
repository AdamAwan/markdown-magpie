import {
  Activity,
  BookOpen,
  CalendarClock,
  ChartColumn,
  CircleDashed,
  ClipboardList,
  GitPullRequest,
  ListChecks,
  MessageCircleQuestion,
  MessageSquareText,
  Plug,
  Settings,
  Sprout,
  Waypoints,
  Workflow,
  type LucideIcon
} from "lucide-react";
import { ConsoleSection } from "./types";

export interface SectionNav {
  section: ConsoleSection;
  path: string;
  // The nav icon for this section (a lucide line icon). Replaces the old
  // hand-typed letter glyphs so the sidebar reads as icons, not abbreviations.
  icon: LucideIcon;
  label: string;
  // Sidebar grouping: entries sharing a group render together, with a divider
  // between groups. Entries are listed in display order.
  group: number;
}

// Single source of truth for the console's top-level sections: their URL paths
// and sidebar presentation. Routing, nav highlighting and the topbar title all
// derive the active section from the URL via this table.
export const SECTION_NAV: SectionNav[] = [
  { section: "ask", path: "/ask", icon: MessageCircleQuestion, label: "Ask", group: 1 },
  { section: "knowledge", path: "/knowledge", icon: BookOpen, label: "Knowledge", group: 1 },
  { section: "gaps", path: "/gaps", icon: CircleDashed, label: "Gaps", group: 1 },
  { section: "seed", path: "/seed", icon: Sprout, label: "Seed", group: 1 },
  { section: "questionnaires", path: "/questionnaires", icon: ClipboardList, label: "Questionnaires", group: 1 },
  { section: "proposals", path: "/proposals", icon: GitPullRequest, label: "Proposals", group: 1 },
  { section: "source-map", path: "/source-map", icon: Waypoints, label: "Source Map", group: 1 },
  { section: "jobs", path: "/jobs", icon: ListChecks, label: "Jobs", group: 2 },
  { section: "activity", path: "/activity", icon: Activity, label: "Activity", group: 2 },
  { section: "insights", path: "/insights", icon: ChartColumn, label: "Insights", group: 2 },
  { section: "schedules", path: "/schedules", icon: CalendarClock, label: "Schedules", group: 2 },
  { section: "config", path: "/config", icon: Settings, label: "Config", group: 2 },
  { section: "dataflow", path: "/dataflow", icon: Workflow, label: "Data Flow", group: 3 },
  { section: "prompts", path: "/prompts", icon: MessageSquareText, label: "Prompts", group: 3 },
  { section: "mcp", path: "/mcp", icon: Plug, label: "Connect (MCP)", group: 3 }
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
