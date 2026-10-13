---
name: from-request
description: 'Entry point for a new idea, feature, change or prototype bug the user describes in the prompt — classifies it, clarifies it in one round of questions, decides between elaborating it now and parking it in the backlog, then runs it through orchestrate or package-sessions. Use when the user brings a new request that is not a backlog number ("ich hätte gern…", "Idee: …", "im Prototyp fehlt…"), and whenever the user invokes /from-request.'
---

# From a new request to a decided concept

This session becomes the orchestrator: before step 1, check the model
(`orchestrate` → "Model choice" → "Not on Opus?") and wait for the
user's confirmation if it is not Opus.

## 1. Classify

| Kind | Sign | Next |
|---|---|---|
| **Feature / change** | new or different behavior or UI | step 2a |
| **Prototype bug** | the prototype doesn't do what `docs/requirements.md` says, or breaks in a tier | step 2b |
| **Idea for later** | "irgendwann", "notier dir", no urgency | step 2c |

Unsure whether something is a defect or a new wish: check
`docs/requirements.md` and `docs/interaction-concept.md` for what is
decided and ask with that in hand.

## 2a. Feature: clarify once

- Restate the goal in the user's terms, check `FEATURE_BACKLOG.md` for an
  existing entry (then continue with `from-backlog`) and the docs for what
  is decided today.
- Ask everything open in one message with your recommended answers; pick
  defaults for the rest. Open UI questions then become variants in the
  prototype (`orchestrate`, phase 2).

## 2b. Prototype bug: find the cause

Reproduce it in the named tier (a failing unit test for core logic, a
browser run or screenshot for the UI), find the root cause, tell the user
in a few sentences; core logic bugs get the failing test first. A fix
with no design decision goes ahead without waiting; one that changes what
the user sees beyond the decided state waits for the go.

## 2c. Idea for later: park it

Add a `FEATURE_BACKLOG.md` row (`LAST_ID` rule, CLAUDE.md): `Vorschlag`,
`Begründung` with the user's reason and any open question, `Aufwand`, and
a `Prio` the user names or you propose. Commit it (`docs:`) and stop.

## 3. Elaborate

- One coherent change: follow `orchestrate`.
- A request that falls into several independent parts: decide per
  package-sessions → "One session or a round".
