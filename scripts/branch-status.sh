#!/bin/bash
# SessionStart hook: tell the session how far its branch is from main, so a
# long-running branch gets main merged in early instead of at the end (see
# .claude/skills/finish/). Prints one line; never fails the session start.

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
timeout 15 git fetch -q origin main 2>/dev/null || { echo "branch-status: could not fetch origin/main"; exit 0; }
branch=$(git branch --show-current 2>/dev/null)
counts=$(git rev-list --left-right --count HEAD...origin/main 2>/dev/null) || exit 0
ahead=${counts%%[[:space:]]*}
behind=${counts##*[[:space:]]}
if [ "$behind" -gt 0 ]; then
  echo "branch-status: '$branch' is $behind commit(s) behind origin/main and $ahead ahead. Merge origin/main before building on it (finish skill, step 1)."
else
  echo "branch-status: '$branch' is up to date with origin/main ($ahead commit(s) ahead)."
fi
exit 0
