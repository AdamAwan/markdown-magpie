import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "@magpie/logger";

// A configured data directory the app must be able to write, paired with the env
// var an operator sets to relocate it. Used to turn an unwritable mount into one
// loud boot warning instead of a silent per-run failure (see issue #130).
export interface DataPathProbe {
  label: string;
  envVar: string;
  dir: string;
}

// Probes a directory for writability the way the app will use it at runtime:
// create it recursively, then write and delete a temp probe file. Returns
// undefined on success or the failure's message otherwise. Never throws, so a
// boot-time check can report the problem without aborting startup.
export async function checkPathWritable(dir: string): Promise<string | undefined> {
  const probe = path.join(dir, ".magpie-write-probe");
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(probe, "");
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    // Best-effort cleanup; a missing probe (write never happened) is not an error.
    await rm(probe, { force: true }).catch(() => undefined);
  }
}

// Boot-time check: for each configured data path, emit a single prominent warning
// if it is not writable — naming the resolved absolute path, the underlying error,
// and the env var to set. Non-fatal: the app still starts, but the operator sees
// the misconfiguration immediately instead of via per-run log archaeology.
export async function preflightDataPaths(paths: DataPathProbe[], log: Logger): Promise<void> {
  for (const { label, envVar, dir } of paths) {
    const error = await checkPathWritable(dir);
    if (error) {
      log.warn(
        { path: dir, envVar, err: error },
        `${label} is not writable (${dir}): ${error}. ` +
          `Set ${envVar} to a writable, mounted path or the ${label.toLowerCase()} step will fail on every run.`
      );
    }
  }
}
