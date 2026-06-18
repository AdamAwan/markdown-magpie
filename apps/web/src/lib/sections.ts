import { ConsoleSection } from "./types";

export interface SectionNav {
  section: ConsoleSection;
  path: string;
  glyph: string;
  label: string;
}

// Single source of truth for the console's top-level sections: their URL paths
// and sidebar presentation. Routing, nav highlighting and the topbar title all
// derive the active section from the URL via this table.
export const SECTION_NAV: SectionNav[] = [
  { section: "ask", path: "/ask", glyph: "Q", label: "Ask" },
  { section: "knowledge", path: "/knowledge", glyph: "K", label: "Knowledge" },
  { section: "gaps", path: "/gaps", glyph: "G", label: "Gaps" },
  { section: "jobs", path: "/jobs", glyph: "J", label: "Jobs" },
  { section: "proposals", path: "/proposals", glyph: "P", label: "Proposals" },
  { section: "crunch", path: "/crunch", glyph: "Cr", label: "Crunch" },
  { section: "prompts", path: "/prompts", glyph: "Pr", label: "Prompts" },
  { section: "dataflow", path: "/dataflow", glyph: "D", label: "Data Flow" },
  { section: "config", path: "/config", glyph: "C", label: "Config" }
];

export const DEFAULT_SECTION: ConsoleSection = "ask";
export const DEFAULT_SECTION_PATH = "/ask";

export function sectionPath(section: ConsoleSection): string {
  return SECTION_NAV.find((entry) => entry.section === section)?.path ?? DEFAULT_SECTION_PATH;
}

export function sectionFromPath(pathname: string): ConsoleSection {
  return SECTION_NAV.find((entry) => entry.path === pathname)?.section ?? DEFAULT_SECTION;
}
