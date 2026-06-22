export function parseLimit(value: string | null, defaultLimit: number): number {
  // Number() (unlike parseInt) rejects trailing garbage like "12abc" rather than
  // silently parsing it to 12; fall back to the default for anything non-integer.
  const parsed = Number(value);
  if (value === null || value.trim() === "" || !Number.isInteger(parsed)) {
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

export function apiLink(path: string): string {
  return `/api${path}`;
}
