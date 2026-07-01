import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  GRANDFATHERED_DUPLICATE_PREFIXES,
  assertMigrationPrefixesUnique,
  groupByPrefix,
  migrationPrefix
} from "./migration-order.mjs";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "packages",
  "db",
  "migrations"
);

test("migrationPrefix extracts the numeric sequence prefix", () => {
  assert.equal(migrationPrefix("0027_fix_patrol.sql"), "0027");
  assert.equal(migrationPrefix("0001_initial.sql"), "0001");
});

test("migrationPrefix returns null for malformed names", () => {
  assert.equal(migrationPrefix("initial.sql"), null);
  assert.equal(migrationPrefix("0001_initial.txt"), null);
  assert.equal(migrationPrefix("_0001_initial.sql"), null);
});

test("groupByPrefix collects files sharing a prefix", () => {
  const groups = groupByPrefix(["0006_a.sql", "0006_b.sql", "0007_c.sql"]);
  assert.deepEqual(groups.get("0006"), ["0006_a.sql", "0006_b.sql"]);
  assert.deepEqual(groups.get("0007"), ["0007_c.sql"]);
});

test("accepts a set of unique prefixes", () => {
  assert.doesNotThrow(() => assertMigrationPrefixesUnique(["0001_a.sql", "0002_b.sql", "0003_c.sql"]));
});

test("rejects a new duplicate prefix", () => {
  assert.throws(
    () => assertMigrationPrefixesUnique(["0040_a.sql", "0040_b.sql"]),
    /Duplicate migration sequence prefix "0040"/
  );
});

test("grandfathered prefixes are allowed to collide", () => {
  assert.doesNotThrow(() =>
    assertMigrationPrefixesUnique(["0006_a.sql", "0006_b.sql"], {
      grandfathered: new Set(["0006"])
    })
  );
});

test("rejects malformed migration filenames", () => {
  assert.throws(() => assertMigrationPrefixesUnique(["0001_ok.sql", "nope.sql"]), /Migration files must be named/);
});

test("aggregates multiple problems into one error", () => {
  let error;
  try {
    assertMigrationPrefixesUnique(["0050_a.sql", "0050_b.sql", "bad.sql"]);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, "expected an error");
  assert.match(error.message, /Duplicate migration sequence prefix "0050"/);
  assert.match(error.message, /Migration files must be named/);
});

test("the real migrations directory satisfies the guard", async () => {
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql"));
  assert.doesNotThrow(() => assertMigrationPrefixesUnique(files));
});

test("every current collision is listed in the grandfathered set", async () => {
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql"));
  const collisions = [...groupByPrefix(files)].filter(([, group]) => group.length > 1).map(([prefix]) => prefix);
  for (const prefix of collisions) {
    assert.ok(GRANDFATHERED_DUPLICATE_PREFIXES.has(prefix), `prefix ${prefix} collides but is not grandfathered`);
  }
});
