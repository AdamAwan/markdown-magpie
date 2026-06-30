import { existsSync } from "node:fs";
import { logger } from "../logger.js";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { SourceDataContext } from "@magpie/core";
import type { ConfiguredKnowledgeRepository } from "../stores/knowledge-repositories.js";
import { toPosixPath } from "./paths.js";
import type { RepositoryDeps } from "./repositories.js";
import { resolveConfiguredRepositoryLocalPath } from "./repositories.js";

export async function collectSourceContext(
  deps: RepositoryDeps,
  sourceIds: string[] | undefined
): Promise<SourceDataContext[]> {
  const selectedSources = selectSources(deps, sourceIds);
  logger.debug(
    { count: selectedSources.length, sources: selectedSources.map((source) => `${source.id}(${source.kind})`).join(", ") || "none" },
    "collecting source context"
  );
  if (sourceIds?.length && selectedSources.length === 0) {
    logger.warn({ sourceIds }, "requested source ids matched no configured sources; check KNOWLEDGE_SOURCES");
  }
  const contexts: SourceDataContext[] = [];

  for (const source of selectedSources) {
    if (source.kind === "internet") {
      contexts.push({
        sourceId: source.id,
        sourceName: source.name,
        kind: source.kind,
        url: source.url,
        content: source.url
          ? "Use this internet source as supporting raw material."
          : "Use relevant internet research as supporting raw material."
      });
      logger.debug({ sourceId: source.id, url: source.url }, "source: internet reference; content is not fetched");
      continue;
    }

    if (source.kind === "agent") {
      contexts.push({
        sourceId: source.id,
        sourceName: source.name,
        kind: source.kind,
        content: "Use general agent knowledge as supporting raw material where no configured repository or URL is available."
      });
      logger.debug({ sourceId: source.id }, "source: agent knowledge reference; no repository content attached");
      continue;
    }

    try {
      const localPath = await resolveConfiguredRepositoryLocalPath(source, deps.checkoutRoot);
      const localContexts = await collectLocalSourceContext(source, localPath);
      contexts.push(...localContexts);
      const fileContexts = localContexts.filter((context) => context.path);
      const totalBytes = fileContexts.reduce((sum, context) => sum + (context.content?.length ?? 0), 0);
      if (fileContexts.length === 0) {
        logger.warn({ sourceId: source.id, localPath, subpath: source.subpath }, "source: no usable files collected; drafts will have no real material");
      } else {
        logger.debug({ sourceId: source.id, fileCount: fileContexts.length, totalBytes, localPath }, "source: collected files");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "unavailable source";
      logger.error({ sourceId: source.id, err: message }, "source: failed to collect context");
      contexts.push({
        sourceId: source.id,
        sourceName: source.name,
        kind: source.kind,
        path: source.path,
        url: source.url,
        content: `Source unavailable: ${message}`
      });
    }
  }

  return contexts;
}

function selectSources(
  deps: RepositoryDeps,
  sourceIds: string[] | undefined
): ConfiguredKnowledgeRepository[] {
  if (deps.knowledgeConfig.sources.length === 0) {
    return [];
  }

  const requested = new Set((sourceIds ?? []).map((id) => id.trim()).filter(Boolean));
  if (requested.size === 0) {
    return deps.knowledgeConfig.sources.slice(0, 3);
  }

  return deps.knowledgeConfig.sources.filter((source) => requested.has(source.id));
}

async function collectLocalSourceContext(
  source: ConfiguredKnowledgeRepository,
  root: string
): Promise<SourceDataContext[]> {
  if (!existsSync(root)) {
    logger.warn({ sourceId: source.id, root, subpath: source.subpath }, "source: path does not exist");
    return [
      {
        sourceId: source.id,
        sourceName: source.name,
        kind: source.kind,
        path: root,
        url: source.url,
        content: "Source path does not exist."
      }
    ];
  }

  const files = await findSourceContextFiles(root);
  logger.debug({ sourceId: source.id, fileCount: files.length, root }, "source: found candidate text files");
  const contexts: SourceDataContext[] = [];
  let remainingBytes = 80_000;

  for (const file of files.slice(0, 24)) {
    if (remainingBytes <= 0) {
      break;
    }
    const content = await readFile(file, "utf8");
    const excerpt = content.slice(0, Math.min(content.length, remainingBytes, 8_000));
    remainingBytes -= excerpt.length;
    contexts.push({
      sourceId: source.id,
      sourceName: source.name,
      kind: source.kind,
      path: toPosixPath(path.relative(root, file)),
      url: source.url,
      content: excerpt
    });
  }

  return contexts;
}

async function findSourceContextFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await walkSourceFiles(root, files);
  return files.sort((left, right) => sourceFilePriority(left) - sourceFilePriority(right) || left.localeCompare(right));
}

async function walkSourceFiles(root: string, files: string[]): Promise<void> {
  const entries = await readdir(root);
  for (const entry of entries) {
    if (ignoredSourceEntry(entry)) {
      continue;
    }

    const fullPath = path.join(root, entry);
    const entryStat = await stat(fullPath);
    if (entryStat.isDirectory()) {
      await walkSourceFiles(fullPath, files);
      continue;
    }

    if (entryStat.isFile() && entryStat.size <= 250_000 && isTextSourceFile(entry)) {
      files.push(fullPath);
    }
  }
}

function ignoredSourceEntry(entry: string): boolean {
  return new Set([".git", "node_modules", "dist", "build", ".next", "coverage", "vendor", ".turbo"]).has(entry);
}

function isTextSourceFile(entry: string): boolean {
  return /\.(?:md|mdx|txt|ts|tsx|js|jsx|mjs|cjs|json|yml|yaml|toml|py|go|rs|cs|java|kt|swift|php|rb|css|scss|html)$/i.test(entry);
}

function sourceFilePriority(file: string): number {
  const basename = path.basename(file).toLowerCase();
  if (/^readme(?:\..+)?$/.test(basename)) {
    return 0;
  }
  if (["package.json", "pyproject.toml", "cargo.toml", "go.mod"].includes(basename)) {
    return 1;
  }
  if (/\.(?:md|mdx)$/i.test(basename)) {
    return 2;
  }
  return 3;
}
