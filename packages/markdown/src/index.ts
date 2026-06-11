import type { DocumentMetadata, DocumentSection, KnowledgeDocument } from "@magpie/core";

export interface ParsedMarkdown {
  metadata: DocumentMetadata;
  body: string;
}

export function parseMarkdownDocument(content: string): ParsedMarkdown {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  const rawFrontmatter = frontmatterMatch?.[1] ?? "";
  const body = frontmatterMatch ? content.slice(frontmatterMatch[0].length) : content;

  return {
    metadata: parseSimpleFrontmatter(rawFrontmatter, body),
    body
  };
}

export function splitIntoSections(document: KnowledgeDocument): DocumentSection[] {
  const parsed = parseMarkdownDocument(document.content);
  const lines = parsed.body.split(/\r?\n/);
  const sections: DocumentSection[] = [];
  const headingStack: string[] = [];
  let currentHeading = parsed.metadata.title;
  let currentLevel = 1;
  let currentLines: string[] = [];
  let ordinal = 0;

  const flush = () => {
    const content = currentLines.join("\n").trim();
    if (!content) {
      return;
    }

    const headingPath = headingStack.length > 0 ? [...headingStack] : [currentHeading];
    sections.push({
      id: `${document.id}:${ordinal}`,
      documentId: document.id,
      path: document.path,
      heading: currentHeading,
      headingPath,
      anchor: slugify(headingPath.join("-")),
      content,
      ordinal
    });
    ordinal += 1;
  };

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      currentLines = [line];
      currentLevel = heading[1].length;
      currentHeading = heading[2].trim();
      headingStack.splice(currentLevel - 1);
      headingStack[currentLevel - 1] = currentHeading;
      continue;
    }

    currentLines.push(line);
  }

  flush();
  return sections;
}

function parseSimpleFrontmatter(raw: string, body: string): DocumentMetadata {
  const values = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match) {
      values.set(match[1], match[2].trim());
    }
  }

  return {
    title: values.get("title") || inferTitle(body),
    owner: values.get("owner") || undefined,
    status: normalizeStatus(values.get("status")),
    lastVerified: values.get("last_verified") || undefined,
    reviewCycleDays: numberOrUndefined(values.get("review_cycle_days")),
    tags: parseInlineList(values.get("tags")),
    relatedDocs: parseInlineList(values.get("related_docs"))
  };
}

function inferTitle(body: string): string {
  const heading = /^#\s+(.+)$/m.exec(body);
  return heading?.[1].trim() || "Untitled";
}

function normalizeStatus(value: string | undefined): DocumentMetadata["status"] {
  if (value === "draft" || value === "deprecated" || value === "archived") {
    return value;
  }

  return "active";
}

function parseInlineList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function numberOrUndefined(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
