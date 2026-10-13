---
name: from-backlog
description: Entry point for elaborating one or more FEATURE_BACKLOG.md entries by their Nr — reads the entry, checks it against what is already decided, settles its open questions with the user, runs it through orchestrate (or package-sessions for several entries) and retires the entry once its requirement is decided and in the prototype. Use when the user names a backlog number ("#12", "Backlog 7 ausarbeiten"), asks to work on backlog items, and whenever the user invokes /from-backlog.
---

# From a backlog entry to a decided concept

This session becomes the orchestrator: before step 1, check the model
(`orchestrate` → "Model choice" → "Not on Opus?") and wait for the
user's confirmation if it is not Opus.

The argument is one or more `Nr`s from `FEATURE_BACKLOG.md` (e.g.
`/from-backlog 12` or `/from-backlog 4 9`).

## 1. Read and re-check the entry

- Find the row by its `Nr`. Unknown or `verworfen`: say so and stop, unless
  the user confirms they want a rejected item after all.
- Backlog entries are raw ideas and can be stale. Check against
  `docs/requirements.md`, `docs/interaction-concept.md` and the prototype
  whether it is already decided in part and whether its premises still
  hold. Report what you found in one or two sentences.

## 2. Scope it with the user

- Restate the goal in behavior terms and list the open questions the
  entry names plus any you found.
- Pick sensible defaults yourself and state them; ask only what changes
  what gets designed — all questions in one message, with your
  recommendation.
- `Aufwand` groß or several areas: propose splitting into steps and say
  which step this session does.

## 3. Elaborate

- One entry: follow `orchestrate` from phase 2 on (variants in the
  prototype where the design is open, then write down and clean up).
- Several independent entries: decide per package-sessions → "One session
  or a round". In a round, every entry is its own package; the start
  prompt carries the entry's `Nr`, its text and the answers from step 2.

## 4. Retire the entry

In the same branch, before `finish`:

- Remove the row from `FEATURE_BACKLOG.md` once its requirement is in
  `docs/requirements.md` and it works in the prototype. Its `Nr` is
  retired, `LAST_ID` does not change (CLAUDE.md).
- A part that stays open (a later step, a follow-up found on the way)
  becomes a **new** entry with the next `LAST_ID`, naming the old `Nr` it
  came from; the old row is not kept as a placeholder.
- Name the `Nr` in the requirement and in the commit message
  (`feat: tag filter (backlog #12)`).
