export function parseLimit(value: string | null, defaultLimit: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return defaultLimit;
  }

  return Math.max(1, Math.min(parsed, 200));
}

export function normalizeRelativePath(value: string | undefined): string {
  return value?.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") ?? "";
}

export function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "docs-update"
  );
}

export function apiLink(path: string): string {
  return `/api${path}`;
}
