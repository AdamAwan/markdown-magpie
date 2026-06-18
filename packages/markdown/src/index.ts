import type { DocumentMetadata, DocumentSection, KnowledgeDocument } from "@magpie/core";

export interface ParsedMarkdown {
  metadata: DocumentMetadata;
  body: string;
}

export function parseMarkdownDocument(content: string): ParsedMarkdown {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
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
  const headingStack: Array<string | undefined> = [];
  const usedAnchors = new Set<string>();
  let currentHeading = parsed.metadata.title;
  let currentLines: string[] = [];
  let ordinal = 0;
  let inFence = false;

  const uniqueAnchor = (base: string, ordinalForFallback: number): string => {
    let anchor = base || `section-${ordinalForFallback}`;
    if (usedAnchors.has(anchor)) {
      let suffix = 2;
      while (usedAnchors.has(`${anchor}-${suffix}`)) {
        suffix += 1;
      }
      anchor = `${anchor}-${suffix}`;
    }
    usedAnchors.add(anchor);
    return anchor;
  };

  const flush = () => {
    const content = currentLines.join("\n").trim();
    // A heading with no body still emits a section so it stays visible to
    // retrieval; only truly empty (heading-less, body-less) buffers are skipped.
    const hasHeadingLine = currentLines.some((line) => /^(#{1,6})\s+(.+)$/.test(line));
    if (!content && !hasHeadingLine) {
      return;
    }

    // Compact the stack so a doc starting at `##` (a hole at index 0) does not
    // produce a leading "-" in the joined heading path / anchor.
    const compactedStack = headingStack.filter((entry): entry is string => entry !== undefined);
    const headingPath = compactedStack.length > 0 ? compactedStack : [currentHeading];
    sections.push({
      id: `${document.id}:${ordinal}`,
      documentId: document.id,
      path: document.path,
      heading: currentHeading,
      headingPath,
      anchor: uniqueAnchor(slugify(headingPath.join("-")), ordinal),
      content,
      ordinal
    });
    ordinal += 1;
  };

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      currentLines.push(line);
      continue;
    }

    const heading = inFence ? null : /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      currentLines = [line];
      const currentLevel = heading[1].length;
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

  // Number() rejects trailing garbage (e.g. "5x") that parseInt would accept as
  // 5, so a malformed review_cycle_days isn't silently coerced.
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
