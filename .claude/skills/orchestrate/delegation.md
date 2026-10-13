# Briefing an implementer

The implementer starts cold: it knows only CLAUDE.md, its agent
definition, and what you write. Everything you already found out goes in
the brief — it must not re-derive it.

## Brief template (Agent prompt)

```
## Goal
<1–3 sentences: what the mockup page shows and lets the user do>

## Spec
<Chosen variant + its artifact URL, or the plan path:
 "Follow the plan in <scratchpad>/plan-<topic>.md, step N only.">
<Exact labels, states, tier differences, empty states the user decided>

## Where
<mockups/<page>.html (new or existing), what in mockups/shared/ to use or
 extend, the docs/requirements.md section that describes it>

## Parallel (only when other agents run at the same time)
<Worktree; commit on your worktree branch. Do not touch mockups/shared/
 unless this brief says so. Pages the other running steps touch — stay out.>

## Out of scope
<What not to touch / not to "improve" along the way>

## Progress
Append one line per milestone to <scratchpad>/progress-<topic>.md
(time, what is done, what is next or what blocks).

## Report back
Files changed, screenshot paths per tier, page errors (none expected),
anything you deviated from or could not do, open questions. Do not commit.
```

## Rules

- One brief = one coherent step. A second step is a new message to the
  same agent after verification.
- Say what is decided and what the agent may decide itself.
- The decision record (`docs/requirements.md`,
  `docs/interaction-concept.md`) is the lead's; the implementer only
  touches docs the brief names.
- The lead commits after verification; implementers leave changes
  uncommitted in the working tree (worktree agents: they commit in their
  worktree branch, the lead merges).

## Correction messages (SendMessage to the same agent)

Concrete, not "doesn't look right":

```
Round 2 corrections:
1. <what> — seen: <screenshot path>, expected: <…>
2. …
Keep everything else as is. Report back as before.
```
