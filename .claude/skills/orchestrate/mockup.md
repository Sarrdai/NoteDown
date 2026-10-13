# Variant mockup for UI decisions

Purpose: let the user decide *before* anything is written into the
concept. The variant mockup is a decision document, not the final page.

## Content

1. **Today** — the current state of the affected area: a screenshot of
   the repo mockup (`scripts/screenshot.js`), or "nothing yet" for a new
   area.
2. **Variants** — usually 2–3, labelled A/B/C. If the user proposed one,
   it is variant A and labelled as theirs. Each variant gets:
   - an interactive mock where interaction is the point (open/close,
     select, swipe, switch views). Variants share one state model and one
     set of preset buttons, so they can be compared side by side.
   - **all three tiers** (desktop, tablet, phone — `PROJECT.md` →
     "Device tiers"), e.g. a tier switch that resizes a device frame, or
     the tiers side by side. A variant that only works on some tiers says
     so; that is often the deciding point.
   - 1–2 sentences of behavior, plus a short pro/contra list.
3. **Details that decide the concept** — e.g. a table "state → what the
   view shows", gesture vs. button per tier, labels and empty states.
4. **Recommendation** — one clearly marked box: which variant and why,
   what you would not do and why.

## Look

- The mocked app parts use NoteDown's design tokens from
  `mockups/shared/tokens.css` and content from
  `mockups/shared/sample-data.js`, so variants read like the app. Until
  the first mockup created them, the first variant mockup proposes them
  (and the decided tokens become `tokens.css`).
- Page chrome (headings, notes) may follow the artifact design skill;
  the mocked UI follows the app.

## Mechanics

- Build it as an Artifact (`Artifact` tool, `quickstart`/artifact-design
  first as that tool requires). Source file lives in the scratchpad.
- Text for the user in German; labels that will appear in the app in
  English, exactly as they would ship (unless the requirements decide the
  app's language otherwise).
- Republish to the same URL for iterations, don't create a new artifact
  per round.
- The variant mockup itself is not committed; its URL goes into the
  requirement as the place the decision was made.

Stop after publishing: send the link, name the recommendation in one
line, ask for the decision.
