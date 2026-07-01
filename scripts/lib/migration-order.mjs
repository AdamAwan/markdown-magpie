// Helpers that enforce the migration file-naming convention for
// `packages/db/migrations`. The migrator (`scripts/migrate.mjs`) sorts files by
// full filename, so a numeric prefix is the *only* signal of intended apply
// order. When two files share a prefix (e.g. `0027_a.sql` / `0027_b.sql`) the
// number no longer disambiguates them and ordering becomes an incidental,
// alphabetical-on-the-suffix accident — a hazard if a future migration ever
// depends on a same-numbered sibling.
//
// We can't safely renumber the collisions that already exist: migrations are
// tracked by full filename in `schema_migrations`, so renaming an applied file
// makes the migrator treat it as new and re-run it. Instead this is a
// forward-only convention — the existing collisions below are grandfathered,
// and any *new* duplicate prefix fails the migrator fast.

// Numeric prefixes that already collided when this guard was introduced. These
// migrations have shipped and may be applied in real environments, so they
// cannot be renumbered; they are grandfathered rather than renamed. Do NOT add
// new entries here — introduce new migrations with unique, sequential prefixes.
export const GRANDFATHERED_DUPLICATE_PREFIXES = new Set(["0006", "0027", "0028", "0034"]);

const MIGRATION_FILENAME = /^(\d+)_.+\.sql$/;

/**
 * Extract the numeric sequence prefix from a migration filename.
 * Returns `null` when the name doesn't follow the `NNNN_description.sql` shape.
 */
export function migrationPrefix(filename) {
  const match = MIGRATION_FILENAME.exec(filename);
  return match ? match[1] : null;
}

/**
 * Group migration filenames by their numeric prefix.
 * @returns {Map<string, string[]>} prefix -> filenames (insertion order preserved)
 */
export function groupByPrefix(filenames) {
  const groups = new Map();
  for (const filename of filenames) {
    const prefix = migrationPrefix(filename);
    if (prefix === null) {
      continue;
    }
    const existing = groups.get(prefix);
    if (existing) {
      existing.push(filename);
    } else {
      groups.set(prefix, [filename]);
    }
  }
  return groups;
}

/**
 * Throw if any migration filename is malformed or if two files share a numeric
 * prefix that isn't grandfathered. Aggregates every problem into a single error
 * so a contributor sees all of them at once.
 *
 * @param {string[]} filenames - migration filenames (e.g. from `readdir`)
 * @param {{ grandfathered?: Set<string> }} [options]
 */
export function assertMigrationPrefixesUnique(filenames, { grandfathered = GRANDFATHERED_DUPLICATE_PREFIXES } = {}) {
  const problems = [];

  const malformed = filenames.filter((name) => migrationPrefix(name) === null);
  if (malformed.length > 0) {
    problems.push(
      `Migration files must be named "NNNN_description.sql". Offending file(s): ${malformed.sort().join(", ")}`
    );
  }

  for (const [prefix, files] of groupByPrefix(filenames)) {
    if (files.length > 1 && !grandfathered.has(prefix)) {
      problems.push(
        `Duplicate migration sequence prefix "${prefix}" shared by: ${files
          .sort()
          .join(", ")}. Give the new migration a unique, sequential prefix.`
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid migration ordering in packages/db/migrations:\n  - ${problems.join("\n  - ")}`);
  }
}
