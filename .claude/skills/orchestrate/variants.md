# Variants in the prototype

Purpose: let the user decide an open UI question by trying the
alternatives in the real prototype, on their own devices, before one of
them becomes the app.

## Building them

- Only where a decision is really open; what the user specified is built
  once, as specified. Usually 2–3 variants, labelled A/B/C; a variant the
  user proposed is A and labelled as theirs.
- Each variant is complete in **all three tiers** (`PROJECT.md` →
  "Device tiers"), or says which tier it doesn't change (a phone-only
  question leaves desktop alone).
- Switching: one setting per open question in `store.js` (`DEFAULT_SETTINGS`),
  a ⋮ menu section "Prototype: <question>" with entries "<Name> (A)", ...,
  and a URL parameter (`main.js` → `applyUrlOptions`). Add the row to
  `PROJECT.md` → "Prototype options".
- Keep variants cheap to delete: a CSS class on `.app` plus a few
  `.app.<variant>` rules, or one small function per variant — never two
  copies of a view.
- The default is your recommendation.

## Presenting them

- Screenshots of each variant in each tier where it differs, same state
  and data (`--query` presets the variant), named so pairs compare side
  by side.
- Per variant: 1–2 sentences of behavior, a short pro/contra list.
- **Recommendation** in one clearly marked line: which variant and why.
- How to try them: `PROJECT.md` → "Running it", ⋮ → "Prototype".
- Labels in the app are English, exactly as they would ship; the text for
  the user is German.

Stop after presenting and ask for the decision (`orchestrate`, phase 2).
After it: phase 3 deletes the losing variants.
