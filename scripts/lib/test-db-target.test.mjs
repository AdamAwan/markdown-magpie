import assert from "node:assert/strict";
import { test } from "node:test";
import { TEST_DATABASE_PREFIX, assertSafeDatabaseName, databaseUrlFor, freshDatabaseName } from "./test-db-target.mjs";

test("freshDatabaseName is prefixed, pid-tagged and unique per call", () => {
  assert.equal(freshDatabaseName(1234, "abcd0123"), `${TEST_DATABASE_PREFIX}1234_abcd0123`);
  const a = freshDatabaseName();
  const b = freshDatabaseName();
  assert.notEqual(a, b);
  assert.match(a, /^magpie_test_\d+_[0-9a-f]{8}$/);
});

test("assertSafeDatabaseName rejects anything that is not a plain identifier", () => {
  for (const bad of ["", "Upper", 'x"; DROP DATABASE postgres; --', "a-b", "a".repeat(64)]) {
    assert.throws(() => assertSafeDatabaseName(bad), /unsafe test database name/);
  }
  assertSafeDatabaseName("magpie_test_1_ab");
});

test("databaseUrlFor swaps only the database path", () => {
  assert.equal(
    databaseUrlFor("postgres://postgres:secret@127.0.0.1:55001/postgres?sslmode=disable", "magpie_test_1_ab"),
    "postgres://postgres:secret@127.0.0.1:55001/magpie_test_1_ab?sslmode=disable"
  );
  assert.equal(
    databaseUrlFor("postgresql://u@db.internal:5432", "magpie_test_2_cd"),
    "postgresql://u@db.internal:5432/magpie_test_2_cd"
  );
});

test("databaseUrlFor rejects non-postgres and malformed URLs", () => {
  assert.throws(() => databaseUrlFor("mysql://root@localhost/x", "magpie_test_1_ab"), /must use postgres/);
  assert.throws(() => databaseUrlFor("not a url", "magpie_test_1_ab"), /not a valid/);
});
