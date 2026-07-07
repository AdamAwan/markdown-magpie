#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const args = process.argv.slice(2);
const limitArg = valueAfter("--limit") ?? valueAfter("-n");
const limit = limitArg ? Number.parseInt(limitArg, 10) : 25;
const thresholdArg = valueAfter("--threshold-ms");
const thresholdMs = thresholdArg ? Number.parseInt(thresholdArg, 10) : 30_000;
const verify = args.includes("--verify");
const requestedWorkspaces = valuesAfter("--workspace").concat(valuesAfter("-w"));

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function valuesAfter(flag) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
}

function workspacePackages() {
  const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const patterns = rootPackage.workspaces ?? [];
  const packages = [];
  for (const pattern of patterns) {
    if (!pattern.endsWith("/*")) continue;
    const base = join(root, pattern.slice(0, -2));
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packageJson = join(base, entry.name, "package.json");
      if (!existsSync(packageJson)) continue;
      const manifest = JSON.parse(readFileSync(packageJson, "utf8"));
      if (manifest.scripts?.test) {
        packages.push({ name: manifest.name, path: join(pattern.slice(0, -2), entry.name), testScript: manifest.scripts.test });
      }
    }
  }
  return packages;
}

function commandWithReporter(testScript, destination) {
  const reporter = ` --test-reporter=tap --test-reporter-destination=${shellQuote(destination)}`;
  return testScript.replace(/(^|\s)--test(?=\s|$)/, `$1--test${reporter}`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function parseDurations(output, workspace) {
  const rows = [];
  let current;
  for (const line of output.split(/\r?\n/)) {
    const subtest = line.match(/^# Subtest: (.+)$/);
    if (subtest) {
      current = subtest[1];
      continue;
    }
    const duration = line.match(/^\s*duration_ms: ([0-9.]+)/);
    if (duration && current) {
      rows.push({ workspace, test: current, ms: Number.parseFloat(duration[1]) });
      current = undefined;
    }
  }
  return rows;
}

const allWorkspaces = workspacePackages();
const selected =
  requestedWorkspaces.length === 0
    ? allWorkspaces
    : allWorkspaces.filter((workspace) => requestedWorkspaces.includes(workspace.name) || requestedWorkspaces.includes(workspace.path));

if (selected.length === 0) {
  console.error("No matching test workspaces found.");
  process.exit(1);
}

const rows = [];
let failed = false;
const tempDir = mkdtempSync(join(tmpdir(), "magpie-test-timings-"));
for (const workspace of selected) {
  const started = process.hrtime.bigint();
  const tapFile = join(tempDir, `${workspace.name.replace(/[^a-z0-9_.-]/gi, "_")}.tap`);
  const result = spawnSync(commandWithReporter(workspace.testScript, tapFile), {
    cwd: join(root, workspace.path),
    encoding: "utf8",
    shell: true,
    stdio: ["ignore", "inherit", "inherit"]
  });
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  rows.push({ workspace: workspace.name, test: "(workspace wall time)", ms: wallMs });
  const tap = existsSync(tapFile) ? readFileSync(tapFile, "utf8") : "";
  rows.push(...parseDurations(tap, workspace.name));
  if (result.status !== 0) {
    failed = true;
    console.error(`\n${workspace.name} failed with exit code ${result.status ?? "unknown"}.`);
  }
}
rmSync(tempDir, { recursive: true, force: true });

const sorted = rows.sort((a, b) => b.ms - a.ms).slice(0, Number.isFinite(limit) && limit > 0 ? limit : 25);
console.log(`\nSlowest test timings (${sorted.length} shown):`);
for (const row of sorted) {
  console.log(`${(row.ms / 1000).toFixed(2)}s\t${row.workspace}\t${row.test}`);
}

if (verify) {
  const slow = rows.filter((row) => row.test !== "(workspace wall time)" && row.ms > thresholdMs);
  if (slow.length > 0) {
    console.error(`\n${slow.length} test file(s) exceeded ${thresholdMs}ms.`);
    for (const row of slow.sort((a, b) => b.ms - a.ms)) {
      console.error(`${(row.ms / 1000).toFixed(2)}s\t${row.workspace}\t${row.test}`);
    }
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
