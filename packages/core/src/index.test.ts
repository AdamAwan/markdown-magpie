import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aiUsageFromTokenCounts,
  ALLOWED_GIT_CLONE_PROTOCOLS,
  GIT_ALLOW_PROTOCOL_VALUE,
  isAllowedGitCloneUrl,
  isValidCron,
  KNOWLEDGE_CHANGE_CAUSES,
  KNOWLEDGE_CHANGE_KINDS,
  MAINTENANCE_LENSES,
  nextCronTime,
  NO_SOURCE_MATERIAL_GAP_PREFIX,
  PROPOSAL_STATUSES,
  proposalFileName,
  resolveProposalTargetPath,
  TERMINAL_PROPOSAL_STATUSES
} from "./index.js";

// @magpie/core is almost entirely type declarations. These tests cover the
// little runtime it does own: the shared constant tuples, the proposal path
// helpers, token-usage normalisation, the git clone URL guard, and cron.

function assertUnique(values: readonly string[]): void {
  assert.equal(new Set(values).size, values.length, `duplicate entry in ${JSON.stringify(values)}`);
}

describe("shared constant tuples", () => {
  it("hold no duplicate members", () => {
    assertUnique(KNOWLEDGE_CHANGE_KINDS);
    assertUnique(KNOWLEDGE_CHANGE_CAUSES);
    assertUnique(PROPOSAL_STATUSES);
    assertUnique(TERMINAL_PROPOSAL_STATUSES);
    assertUnique(MAINTENANCE_LENSES);
    assertUnique(ALLOWED_GIT_CLONE_PROTOCOLS);
  });

  it("keeps 'external' as a knowledge-change cause (the default for hand edits)", () => {
    assert.ok(KNOWLEDGE_CHANGE_CAUSES.includes("external"));
  });

  it("keeps every terminal proposal status a real proposal status", () => {
    for (const status of TERMINAL_PROPOSAL_STATUSES) {
      assert.ok(PROPOSAL_STATUSES.includes(status), `${status} is not in PROPOSAL_STATUSES`);
    }
  });

  it("treats exactly merged/rejected/superseded as terminal, never an in-flight status", () => {
    assert.deepEqual([...TERMINAL_PROPOSAL_STATUSES].sort(), ["merged", "rejected", "superseded"]);
    for (const inFlight of ["draft", "ready", "branch-pushed", "pr-opened"] as const) {
      assert.ok(PROPOSAL_STATUSES.includes(inFlight));
      assert.ok(!TERMINAL_PROPOSAL_STATUSES.includes(inFlight));
    }
  });

  it("pins the no-source-material gap prefix the watcher builds and the API recognises", () => {
    assert.equal(NO_SOURCE_MATERIAL_GAP_PREFIX, "No sufficient source material found for:");
  });
});

describe("proposalFileName", () => {
  it("slugifies a title into a lower-case hyphenated .md name", () => {
    assert.equal(proposalFileName("How do I Reset my Password?"), "how-do-i-reset-my-password.md");
  });

  it("collapses runs of non-alphanumerics and trims leading/trailing hyphens", () => {
    assert.equal(proposalFileName("  --Hello,   World!!  "), "hello-world.md");
  });

  it("falls back to knowledge-gap.md when nothing sluggable remains", () => {
    assert.equal(proposalFileName(""), "knowledge-gap.md");
    assert.equal(proposalFileName("!!! ???"), "knowledge-gap.md");
  });

  it("caps the slug at 60 characters", () => {
    assert.equal(proposalFileName("a".repeat(100)), `${"a".repeat(60)}.md`);
  });

  it("does not leave a trailing hyphen when the cap lands on a separator", () => {
    assert.equal(proposalFileName(`${"a".repeat(59)} tail`), `${"a".repeat(59)}.md`);
  });
});

describe("resolveProposalTargetPath", () => {
  it("returns the bare file name when there is no subpath", () => {
    assert.equal(resolveProposalTargetPath(undefined, "My Doc"), "my-doc.md");
    assert.equal(resolveProposalTargetPath("", "My Doc"), "my-doc.md");
    assert.equal(resolveProposalTargetPath("/", "My Doc"), "my-doc.md");
  });

  it("joins the subpath and file name with a single slash", () => {
    assert.equal(resolveProposalTargetPath("docs/kb", "My Doc"), "docs/kb/my-doc.md");
  });

  it("strips leading and trailing slashes from the subpath", () => {
    assert.equal(resolveProposalTargetPath("//docs/kb//", "My Doc"), "docs/kb/my-doc.md");
  });

  it("normalises Windows separators", () => {
    assert.equal(resolveProposalTargetPath("docs\\kb\\", "My Doc"), "docs/kb/my-doc.md");
  });
});

describe("aiUsageFromTokenCounts", () => {
  it("returns undefined when nothing usable was reported", () => {
    assert.equal(aiUsageFromTokenCounts({}), undefined);
    assert.equal(aiUsageFromTokenCounts({ inputTokens: "12", outputTokens: null, totalTokens: Number.NaN }), undefined);
  });

  it("passes through valid integer counts, including zero", () => {
    assert.deepEqual(aiUsageFromTokenCounts({ inputTokens: 10, outputTokens: 0, totalTokens: 10 }), {
      inputTokens: 10,
      outputTokens: 0,
      totalTokens: 10
    });
  });

  it("rounds fractional counts to integers", () => {
    assert.deepEqual(aiUsageFromTokenCounts({ inputTokens: 1.4, outputTokens: 2.5 }), {
      inputTokens: 1,
      outputTokens: 3
    });
  });

  it("drops negative, non-finite and non-number counts but keeps the valid ones", () => {
    const usage = aiUsageFromTokenCounts({
      inputTokens: -1,
      outputTokens: Number.POSITIVE_INFINITY,
      totalTokens: 42
    });
    assert.deepEqual(usage, { totalTokens: 42 });
    assert.ok(usage && !("inputTokens" in usage) && !("outputTokens" in usage));
  });
});

describe("isAllowedGitCloneUrl", () => {
  it("derives GIT_ALLOW_PROTOCOL_VALUE from the allowlist", () => {
    assert.equal(GIT_ALLOW_PROTOCOL_VALUE, "https:http:ssh:file");
    assert.deepEqual(GIT_ALLOW_PROTOCOL_VALUE.split(":"), [...ALLOWED_GIT_CLONE_PROTOCOLS]);
  });

  it("accepts every allowlisted scheme", () => {
    assert.ok(isAllowedGitCloneUrl("https://github.com/acme/docs.git"));
    assert.ok(isAllowedGitCloneUrl("http://git.internal/acme/docs.git"));
    assert.ok(isAllowedGitCloneUrl("ssh://git@github.com/acme/docs.git"));
    assert.ok(isAllowedGitCloneUrl("file:///srv/repos/docs.git"));
  });

  it("matches the scheme case-insensitively and ignores surrounding whitespace", () => {
    assert.ok(isAllowedGitCloneUrl("  HTTPS://github.com/acme/docs.git  "));
  });

  it("accepts the scp-like ssh shorthand", () => {
    assert.ok(isAllowedGitCloneUrl("git@github.com:acme/docs.git"));
  });

  it("accepts bare local filesystem paths (the file transport)", () => {
    assert.ok(isAllowedGitCloneUrl("/srv/repos/docs.git"));
    assert.ok(isAllowedGitCloneUrl("./fixtures/docs.git"));
    assert.ok(isAllowedGitCloneUrl("../docs.git"));
  });

  it("rejects empty and whitespace-only values", () => {
    assert.ok(!isAllowedGitCloneUrl(""));
    assert.ok(!isAllowedGitCloneUrl("   "));
  });

  it("rejects option-like values (argument injection)", () => {
    assert.ok(!isAllowedGitCloneUrl("--upload-pack=touch /tmp/pwned"));
    assert.ok(!isAllowedGitCloneUrl("  -oProxyCommand=evil"));
  });

  it("rejects remote-helper transports (remote code execution)", () => {
    assert.ok(!isAllowedGitCloneUrl("ext::sh -c 'touch /tmp/pwned'"));
    assert.ok(!isAllowedGitCloneUrl("fd::17/foo"));
  });

  it("rejects the unauthenticated git:// protocol and other schemes", () => {
    assert.ok(!isAllowedGitCloneUrl("git://github.com/acme/docs.git"));
    assert.ok(!isAllowedGitCloneUrl("ftp://example.com/docs.git"));
    assert.ok(!isAllowedGitCloneUrl("javascript:alert(1)"));
  });
});

describe("isValidCron", () => {
  it("accepts standard 5-field expressions", () => {
    for (const expr of ["* * * * *", "0 9 * * 1-5", "*/15 0-6 1,15 * *", "0 0 1 1 0", "5-55/10 * * * *"]) {
      assert.ok(isValidCron(expr), expr);
    }
  });

  it("accepts 7 as Sunday and tolerates extra whitespace", () => {
    assert.ok(isValidCron("0 0 * * 7"));
    assert.ok(isValidCron("   0   9  *  * *  "));
  });

  it("rejects the wrong number of fields", () => {
    assert.ok(!isValidCron(""));
    assert.ok(!isValidCron("* * * *"));
    assert.ok(!isValidCron("* * * * * *"));
  });

  it("rejects out-of-range values", () => {
    for (const expr of [
      "60 * * * *",
      "* 24 * * *",
      "* * 0 * *",
      "* * 32 * *",
      "* * * 0 *",
      "* * * 13 *",
      "* * * * 8"
    ]) {
      assert.ok(!isValidCron(expr), expr);
    }
  });

  it("rejects malformed fields", () => {
    for (const expr of ["a * * * *", "*/0 * * * *", "10-5 * * * *", "1, * * * *", "1-2-3 * * * *", "-1 * * * *"]) {
      assert.ok(!isValidCron(expr), expr);
    }
  });
});

describe("nextCronTime", () => {
  // Cron is evaluated in local wall-clock time, so fixtures are built with the
  // local-time Date constructor. Mid-January dates avoid every DST transition.
  // 2026-01-15 is a Thursday.
  const local = (day: number, hour = 0, minute = 0, second = 0): Date => new Date(2026, 0, day, hour, minute, second);

  it("returns undefined for an invalid expression", () => {
    assert.equal(nextCronTime("not a cron", local(15)), undefined);
  });

  it("finds the next matching minute, zeroing seconds", () => {
    assert.deepEqual(nextCronTime("*/15 * * * *", local(15, 10, 7, 30)), local(15, 10, 15));
  });

  it("is strictly after `from`, even when `from` itself matches", () => {
    assert.deepEqual(nextCronTime("*/15 * * * *", local(15, 10, 15)), local(15, 10, 30));
    assert.deepEqual(nextCronTime("* * * * *", local(15, 10, 15, 59)), local(15, 10, 16));
  });

  it("rolls over to the next day", () => {
    assert.deepEqual(nextCronTime("0 9 * * *", local(15, 10)), local(16, 9));
  });

  it("rolls over to the next month and year", () => {
    assert.deepEqual(nextCronTime("30 6 1 * *", local(15)), new Date(2026, 1, 1, 6, 30));
    assert.deepEqual(nextCronTime("0 0 1 1 *", local(15)), new Date(2027, 0, 1));
  });

  it("matches day-of-week, with 0 and 7 both meaning Sunday", () => {
    assert.deepEqual(nextCronTime("0 0 * * 0", local(15)), local(18));
    assert.deepEqual(nextCronTime("0 0 * * 7", local(15)), local(18));
    assert.deepEqual(nextCronTime("0 9 * * 1-5", local(16, 12)), local(19, 9));
  });

  it("ORs day-of-month and day-of-week when both are restricted (Vixie rule)", () => {
    // Sunday the 18th matches on day-of-week before the 20th matches on day-of-month.
    assert.deepEqual(nextCronTime("0 0 20 * 0", local(15)), local(18));
    assert.deepEqual(nextCronTime("0 0 20 * 0", local(18)), local(20));
  });

  it("requires day-of-month alone when day-of-week is unrestricted", () => {
    assert.deepEqual(nextCronTime("0 0 20 * *", local(15)), local(20));
  });

  it("returns undefined when nothing matches within a year", () => {
    assert.equal(nextCronTime("0 0 30 2 *", local(15)), undefined);
  });

  it("does not mutate `from`", () => {
    const from = local(15, 10, 7, 30);
    const before = from.getTime();
    nextCronTime("0 9 * * *", from);
    assert.equal(from.getTime(), before);
  });
});
