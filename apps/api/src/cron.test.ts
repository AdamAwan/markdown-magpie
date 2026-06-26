import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidCron, nextCronTime } from "@magpie/core";

// Coverage for the shared cron helpers used by the scheduled-task settings editor
// and the scheduled-tasks routes' cron validation.

test("nextCronTime resolves the next matching minute in local time", () => {
  // 02:00 daily, from 01:30 the same day → 02:00 the same day.
  const from = new Date(2026, 0, 1, 1, 30, 0);
  const next = nextCronTime("0 2 * * *", from);
  assert.ok(next);
  assert.equal(next?.getHours(), 2);
  assert.equal(next?.getMinutes(), 0);
  assert.equal(next?.getDate(), 1);

  // After today's run has passed, it rolls to the next day.
  const after = nextCronTime("0 2 * * *", new Date(2026, 0, 1, 2, 0, 0));
  assert.equal(after?.getDate(), 2);
});

test("isValidCron accepts standard expressions and rejects malformed ones", () => {
  assert.equal(isValidCron("0 2 * * *"), true);
  assert.equal(isValidCron("*/15 9-17 * * 1-5"), true);
  assert.equal(isValidCron("0 2 * *"), false); // too few fields
  assert.equal(isValidCron("60 2 * * *"), false); // minute out of range
  assert.equal(isValidCron("nonsense"), false);
});
