#!/usr/bin/env bash
# Stop hook — once per session, if the working tree shows substantial change,
# remind the user to consider capturing a reusable skill. Non-blocking: it only
# ever prints a one-line systemMessage (or nothing), never blocks or loops.
#
# Pairs with the `propose-a-skill` skill (.claude/skills/propose-a-skill). Tune
# the CHANGED_FILE_THRESHOLD below, or remove the Stop hook from
# .claude/settings.json to disable. Kept jq-free on purpose (jq isn't guaranteed
# on PATH); session_id is parsed from the hook's stdin JSON with sed.

CHANGED_FILE_THRESHOLD=3

input="$(cat)"

# Extract "session_id":"..." without jq. Empty → a stable per-boot fallback.
sid="$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
[ -n "$sid" ] || sid="nosession"

# Once-per-session gate: a marker keyed by session id.
marker="${TMPDIR:-/tmp}/claude-propose-skill-${sid}"
if [ -e "$marker" ]; then
  exit 0
fi

# Substantial-work proxy: number of changed (tracked+untracked) files.
dir="${CLAUDE_PROJECT_DIR:-$PWD}"
changed="$(git -C "$dir" status --porcelain 2>/dev/null | grep -c .)"
if [ "${changed:-0}" -lt "$CHANGED_FILE_THRESHOLD" ]; then
  # Not substantial yet — stay silent and DON'T set the marker, so the reminder
  # can still fire later once the session accumulates more change.
  exit 0
fi

touch "$marker"
printf '{"systemMessage":"Substantial session (%s files changed). If you repeated a non-obvious workflow worth capturing, consider running /propose-a-skill."}\n' "$changed"
