---
name: finish
description: NoteDown's end-of-session routine for any session that changed files — merge current main with the repo's conflict rules, check every changed mockup for page errors, refresh the docs' tables of contents, push the session branch and report without opening a PR. Use when the work of a session or round is done, before telling the user it is finished, and whenever the user invokes /finish.
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
| `mockups/*.html` | Resolve by understanding both changes; re-shoot the page in every tier. |
| `mockups/shared/*` | Keep both sides' additions (sample notes, tokens); re-shoot every page that uses a changed part, at least in the phone tier. |

## 2. Mockup check (only when `mockups/` changed)

Every changed page, and every page using a changed `mockups/shared/` file,
opens without page errors in every tier:

```bash
for p in <changed pages>; do for d in desktop tablet phone; do
  NODE_PATH="$(npm root -g)" node scripts/screenshot.js "$p" --device $d --out <scratchpad>/final-$(basename "$p" .html)-$d.png
done; done
```

A `page errors` line or a non-zero exit is a finding: fix it before
pushing. The pictures themselves were reviewed in `orchestrate` phase 4.

## 3. Docs check

- `node scripts/doc-toc.js` — refreshes the table of contents of every
  Markdown file over 100 lines (CLAUDE.md rule); commit what it changes.
- Decisions of this session are written down (`docs/requirements.md`,
  `docs/interaction-concept.md`) as current state, with reason and
  variant mockup URL; README if the decided scope changed visibly.
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
is written down, branch name, open points. **Do not open a PR** and do
not request a review unless the user asked for one (CLAUDE.md).
