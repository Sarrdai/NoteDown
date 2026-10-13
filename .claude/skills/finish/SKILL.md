---
name: finish
description: NoteDown's end-of-session routine for any session that changed files — merge current main with the repo's conflict rules, run the unit tests and check the prototype for page errors, refresh the docs' tables of contents, push the session branch and report without opening a PR. Use when the work of a session or round is done, before telling the user it is finished, and whenever the user invokes /finish.
---

# Finish: merge main → checks → docs → push → report

Run this at the end of every session that changed files, and also mid-way
when the SessionStart line says the branch is behind `main` before you
build further on it. The `orchestrate` skill's phase 5 calls it.

## 1. Merge current main

```bash
git fetch origin main && git merge origin/main
```

Never rebase or force-push a branch that is already pushed. Conflict rules:

| File | Resolution |
|---|---|
| `FEATURE_BACKLOG.md` | Keep both sides' rows. `LAST_ID` = the higher value; if both sides used the same new ID, give yours the next free one (`LAST_ID` + 1) and fix any reference to it in your branch. |
| `docs/requirements.md`, `docs/interaction-concept.md`, `PROJECT.md`, `README.md` | Merge by content: the result must describe the current state of both decisions, not two narratives. Two decisions that contradict each other go to the user. |
| `app/sample/notes.md` | Keep both sides' notes; `node --test` checks the file still parses. |
| `app/**` (code) | Resolve by understanding both changes; `node --test`, then re-drive both sides' flows and re-shoot in every tier. |

## 2. Prototype check (only when `app/`, `tests/` or `scripts/` changed)

```bash
node --test
for d in desktop tablet phone; do
  NODE_PATH="$(npm root -g)" node scripts/screenshot.js --device $d --out <scratchpad>/final-$d.png
done
```

Report the test pass count.

A `page errors` line or a non-zero exit is a finding: fix it before
pushing. The pictures themselves were reviewed in `orchestrate` phase 4.

**Server check** (only when `server/` changed): `scripts/test-server.sh`
— all green; report the pass count.

**Sync check** (when `server/` or the sync client changed — `app/js/sync/`,
`crypto.js`, `merge.js`, `store.js`): `scripts/test-sync.sh` — every step
`ok`, ending with "all sync steps passed".

## 3. Docs check

- `node scripts/doc-toc.js` — refreshes the table of contents of every
  Markdown file over 100 lines (CLAUDE.md rule); commit what it changes.
- Decisions of this session are written down (`docs/requirements.md`,
  `docs/interaction-concept.md`, `docs/file-format.md`) as current state,
  with reason; decided variants removed; README if the decided scope
  changed visibly.
- New backlog entries took their ID from `LAST_ID`; decided ones removed.
- A rule or workflow change (`CLAUDE.md`, `.claude/**`) is on its own branch
  off `main`, not mixed into this one (CLAUDE.md → "Process changes").

## 4. Commit and push

- Conventional Commit prefix (`docs:`, `feat:`, `fix:`, `chore:`). No
  `!`, `BREAKING CHANGE:` or `Release-As:`.
- No Claude attribution lines (CLAUDE.md).
- `git push -u origin <branch>`.

## 5. Report

Tell the user, in their language: what was decided and built, where it
is written down, test pass count, branch name, open points. **Do not
open a PR** and do not request a review unless the user asked for one
(CLAUDE.md).
