# Verifying a round

The lead runs all of this itself — an implementer's own "looks fine" is
input, not proof. The same checklist applies to work the lead did itself.

## 1. Diff review

`git diff` (worktree agents: diff their branch). Check against the
decision: everything asked for is there, nothing outside scope changed,
prototype rules kept (`PROJECT.md` → "Prototype": ES modules, no
framework, no runtime requests to other hosts, colors only via the
semantic tokens, sample content only from `app/sample/notes.md`, DOM-free
logic in `app/js/core/` with a unit test).

## 2. Tests and flows

- `node --test` — all green; `scripts/test-server.sh` too when `server/`
  changed.
- Drive the changed flows in headless Chromium in the tiers they touch
  (tap/click, type, check the result in DOM and `localStorage`), plus the
  neighbouring flows the change could break: closing/reopening with
  undo, editing, sorting, search, table-of-contents jumps. A throwaway
  Playwright script in the scratchpad is fine; page errors are findings.

## 3. Screenshots in every tier

```bash
S=<scratchpad>
for d in desktop tablet phone; do
  NODE_PATH="$(npm root -g)" node scripts/screenshot.js --device $d \
    --out $S/shot-<view>-$d.png [--query "<options>"] [--eval "<js that opens the state>"]
done
```

- Look at every PNG (`Read` it): layout, labels, states, alignment,
  overflow, empty states, touch target sizes on tablet/phone.
- Any `page errors` line in the output is a finding, even if the picture
  looks fine.
- Styling changes: also `--theme dark` (and a non-default flavor via
  `--query flavor=frappe` if tokens changed).
- Interaction: shoot each relevant state (closed/open, empty vs. full,
  editing) via separate `--eval` runs. States are reached through the UI
  (`click()` on the real controls), not by writing note text in `--eval`.
- Variants: every variant in every tier where it differs.

## 4. Decision record and docs

- `docs/requirements.md` / `docs/interaction-concept.md` /
  `docs/file-format.md` describe what the prototype now does — current
  state, edited in place, with the reason.
- Decided variants removed, `PROJECT.md` → "Prototype options" current.
- README if the decided scope changed visibly.
- Backlog entry retired or split (`from-backlog`, step 4).
- `node scripts/doc-toc.js` run.

## Outcome

- All clean → phase 5 (commit, present).
- Findings → one numbered correction message to the same implementer
  with the screenshot paths, then repeat this checklist.
