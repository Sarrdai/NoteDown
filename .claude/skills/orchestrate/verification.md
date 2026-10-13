# Verifying a round

The lead runs all of this itself — an implementer's own "looks fine" is
input, not proof. The same checklist applies to mockup work the lead did
itself.

## 1. Diff review

`git diff` (worktree agents: diff their branch). Check against the
decision: everything asked for is there, nothing outside scope changed,
mockup conventions kept (`PROJECT.md` → "Mockup conventions": no
framework, no external requests, sample content only from
`mockups/shared/sample-data.js`, tokens from `tokens.css`).

## 2. Screenshots in every tier

```bash
S=<scratchpad>
for d in desktop tablet phone; do
  NODE_PATH="$(npm root -g)" node scripts/screenshot.js mockups/<page>.html \
    --device $d --out $S/shot-<page>-$d.png [--eval "<js that opens the state>"]
done
```

- Look at every PNG (`Read` it). Compare with the chosen variant: layout,
  labels, states, alignment, overflow, empty states, touch target sizes on
  tablet/phone.
- Any `page errors` line in the output is a finding, even if the picture
  looks fine.
- Styling changes: also `--theme dark`.
- Interaction: shoot each relevant state (closed/open, empty vs. full,
  one vs. many selected) via separate `--eval` runs.
- A shared change (`mockups/shared/`) re-shoots every page that uses it,
  at least in the phone tier.

## 3. Decision record and docs

- `docs/requirements.md` / `docs/interaction-concept.md` describe what the
  mockup now shows — current state, edited in place, with the reason and
  the variant mockup URL.
- README if the decided scope changed visibly.
- Backlog entry retired or split (`from-backlog`, step 4).
- `node scripts/doc-toc.js` run.

## Outcome

- All clean → phase 5 (commit, present).
- Findings → one numbered correction message to the same implementer
  with the screenshot paths, then repeat this checklist.
