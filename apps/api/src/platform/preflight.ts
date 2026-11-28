import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// A configured data directory the app must be able to write, paired with the env
// var an operator sets to relocate it. Probed at boot so an unmounted/misowned
// path stops startup with one clear message instead of failing every run that
// touches it (issue #130).
export interface DataPathProbe {
  label: string;
  envVar: string;
  dir: string;
}

// Probes a directory for writability the way the app will use it at runtime:
// create it recursively, then write and delete a temp probe file. Returns
// undefined on success or the failure's message otherwise. Never throws.
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

// Boot-time check: every configured data path must be writable, or startup
// aborts with one error naming each offending resolved path, the underlying
// error, and the env var to set. Fails fast (rather than warning) because an
// unwritable checkout or snapshot root breaks every clone, publish and snapshot
// refresh — a deployment that boots in that state only looks healthy.
export async function assertDataPathsWritable(paths: DataPathProbe[]): Promise<void> {
  const failures: string[] = [];
  for (const { label, envVar, dir } of paths) {
    const error = await checkPathWritable(dir);
    if (error) {
      failures.push(
        `  - ${envVar}: ${label} is not writable (${dir}): ${error}. Set ${envVar} to a writable, mounted path.`
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(`Unwritable data directories:\n${failures.join("\n")}`);
  }
}
