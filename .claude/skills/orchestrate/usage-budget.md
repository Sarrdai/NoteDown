# Usage budget: plan limits across sessions

All sessions of one account share the plan's usage windows (five hours and
seven days). When the five-hour window runs out, every session stops at
once; resuming them afterwards re-reads each whole context at cache-write
price (a round once cost ~24 % of a fresh window just by resuming).
Two rules prevent that: **start or wake work only when the window can
carry it**, and **pause before the limit so that work continues from a
short handover, not a resumed big context**.

## Reading the budget

- `list_events` on your own session (ID from `get_session` without
  `session_id`), `kinds: ["rate_limit_event"]`, `limit: 100`. The newest
  event (last entry on the page) has `rate_limit_info.unifiedWindows` with `five_hour` and
  `seven_day`, each with `utilization` (0–1) and `resetsAt` (Unix time).
  The windows are per account, so any session's reading is the round's.
- No event on that page: fall back to `get_session` →
  `external_metadata.rate_limit_info.status`; `allowed_warning` counts as
  "tight" (ask the user before starting anything), `rejected` as empty.
- Check at: before starting or waking a package, before handing an
  implementer a step, and at each step boundary while a package runs.
  Not more often: each read lands in your context.

## Before starting or waking work (orchestrator, lead)

Start a package, wake a waiting one (`send_message`, e.g. a variant
decision) or delegate the next step only if
`five_hour.utilization + estimate ≤ 0.85` and `seven_day.utilization <
0.90`. The 15 % margin is for the orchestrator itself and verification.

| Work | Estimate (five-hour window) |
|---|---|
| Bug fix with known cause or a small change with a clear brief (Sonnet package or subagent) | 5–10 % |
| Variants in the prototype up to the user's decision (Opus) | 10–15 % |
| Decision record + clean-up + remaining build, incl. verification + `finish` | 10–15 % |
| Waking a session idle > 1 h | + 2 % per 100k tokens of its context (`get_session` → `context_usage.used_tokens`) |

- The estimates come from PhiLogg's measured rounds; plan with the upper
  end of a range until NoteDown has its own measurements.
- Parallel packages add up. Doesn't fit: start only what fits (smallest
  or most urgent first) and hold the rest.
- Held work: one `send_later` at `five_hour.resetsAt` + 5 min, and one
  line to the user: what is held and when it continues. A held variant
  decision is passed on at that check-in, not before.
- Record `utilization` at a package's start and at its report; tell the
  user the difference in the round summary. Estimates that are off by
  more than half in two rounds get corrected in this table (process
  change, its own branch off `main`).

## Pausing before the limit (package session, lead)

At a step boundary with `five_hour.utilization ≥ 0.85`, start no new step:

1. Commit and push the current state on your branch, unfinished or not
   (message `WIP: <step>`, unprefixed so it moves no version).
2. Write a handover: goal, decisions (chosen variants), what is done
   (commits), the remaining plan steps verbatim (the scratchpad does not
   survive the container), open questions.
3. Package session: send it to the orchestrator as `[<package>] PAUSED`
   (`package-sessions` → "Reporting back"), then end the turn and do
   nothing more in this session. Lead of a single session: give the user
   the handover as a ready-to-paste start prompt for a fresh session
   after `five_hour.resetsAt` (local time), then stop.

Continuing after the reset means a **fresh session** started from the
handover (`create_session` on the same branch, start prompt = handover),
not resuming the paused one. The handover is a few thousand tokens, the
paused context often 100k+. Tell the user the paused session can be
archived.

## After a limit stop anyway

If the limit hit before a pause: the user resumes **only the
orchestrator**, not the packages. It reads the budget, then per stopped
package `get_session` → `context_usage.used_tokens`:

- Below ~100k: resume it (one at a time, each within the budget rule).
- Above: start a fresh session from its original start prompt plus what
  its branch shows (`git log`, WIP commits) instead of resuming it.
