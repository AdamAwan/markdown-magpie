---
name: propose-a-skill
description: End-of-work retrospective that decides whether the work just done is worth capturing as a reusable skill, and if so drafts one for approval. Use when wrapping up a gnarly or multi-step task, when a Stop-hook reminder suggests it, or whenever asked to "propose/capture a skill". Proposes and drafts — never silently creates.
---

# Propose a skill (retrospective)

A quick, honest reflection at the end of a substantial task: *was any of this reusable
enough to be worth a skill, and did I hit a gotcha another Claude would waste time
rediscovering?* Most sessions produce **nothing** worth capturing — that's the expected
outcome and saying "nothing to capture" is a success, not a failure. The value is catching
the occasional real pattern while the context is still fresh.

**This skill proposes and drafts. It never silently writes a skill into the repo.** A skill
authored from a single session is usually overfit — it encodes one path as if it were the
rule. Always get a human yes before creating one.

## The bar (be strict)

Propose a skill only if **at least two** of these are true — otherwise stop:

1. **Repeated ≥ 2×.** The procedure has been done more than once (this session or before),
   not a one-off. One instance is an anecdote, not a pattern.
2. **Non-obvious.** A capable engineer following the code/docs would still get it wrong —
   there's a gotcha, an ordering constraint, a silent-failure trap, or tribal knowledge.
3. **Cross-cutting or high-friction.** It spans several files/systems, or it cost real time
   to get right (dead ends, back-and-forth).
4. **Stable.** It won't be obsolete next week — it reflects a durable convention, not a
   scaffold you're about to delete.

Also stop (don't propose) when:
- An **existing skill already covers it** — instead, note the one improvement and offer to
  update *that* skill (check `.claude/skills/` first).
- It's a **one-line fix**, a pure code change with no reusable procedure, or something the
  repo already documents (CLAUDE.md, `docs/`, git history).
- It's **specific to this conversation** and won't recur.

## How to run it

1. **Look back over the task.** What procedure did I actually follow? What surprised me or
   cost time? List candidate skill ideas (often zero).
2. **Score each against the bar.** Drop anything that doesn't clear it. Check `.claude/skills/`
   for overlap with existing skills (`add-a-job-type`, `write-a-migration`,
   `writing-magpie-tests`, `run-magpie`, `magpie-orientation`, `magpie-local-troubleshooting`).
3. **Report the verdict concisely.** Either "nothing worth capturing" (with one line why), or
   a short pitch per surviving candidate: *name, what it'd cover, and the specific gotcha(s)
   it would save.* Do not write files yet.
4. **Ask before creating.** Only on an explicit yes, invoke the **`skill-creator`** skill to
   author it — grounded in the real files touched (read them; don't write from memory), in the
   house style of the existing skills (rich, path-specific, with a Gotchas section). Place it
   in `.claude/skills/<name>/SKILL.md` and cross-reference it from `magpie-orientation`'s
   "Task skills" list. Then validate and commit per the project's commit/push cadence.

## Why this isn't an auto-creator

The paired Stop hook (`.claude/settings.json` → `.claude/hooks/propose-skill-reminder.sh`)
only *reminds* — once per session, when the working tree shows substantial change (≥ 3
changed files by default) — surfacing this skill to the human via a one-line message. It never
runs this skill or writes anything itself. Automatic skill *creation* would generate cruft
that mis-triggers later; automatic *reminding* + human-approved drafting keeps the signal
without the noise. Tune the threshold or disable the reminder in that script / settings file.
