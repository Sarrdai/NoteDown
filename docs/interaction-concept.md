# Interaction concept (Bedienkonzept)

Cross-cutting rules for how NoteDown is operated, independent of a single
feature: layout per device tier (`PROJECT.md` → "Device tiers"), input,
feedback and the visual language. Feature-specific behavior stays in
`docs/requirements.md`; a rule moves here once a second feature needs it.

Current state, edited in place when a decision changes.

## Layout per tier

| | Phone (< 600 px) | Tablet (600–1023 px) | Desktop (≥ 1024 px) |
|---|---|---|---|
| Top bar | Title; icons for contents, search, sort, archive (with count), ⋮ | Title, search field, icons | Title, search field, sort and archive with labels, ⋮ |
| Table of contents | Bottom sheet, opened from the top bar | Fixed sidebar on the left | Fixed sidebar on the left |
| Note list | Cards, full width | Cards next to the sidebar | Cards next to the sidebar, at most 780 px wide |
| Search | Icon turns the top bar into a search field | Always visible field | Always visible field |

- One primary action per view, as a floating button at the bottom
  right: + in the main view; none in the archive (nothing is created
  there).
- The archive keeps the main view's layout; only the background tint and
  the back button instead of the archive button tell them apart.

## Input

- **Tap or click** is the main action on content: into a note's text =
  edit, on a task checkbox = toggle, on the round button = close /
  reopen, on a link = open.
- **Long-press** is reserved for secondary modes: on a note it starts
  multi-select, on + it starts dictation. Nothing essential is
  long-press-only on the desktop (Ctrl/Shift+click, keyboard).
- No hover-only controls: everything reachable with the mouse is also
  visible and reachable by touch. Touch targets are at least 44 px
  (task checkboxes get an enlarged invisible target).
- The list never reorders while the user works in it — only after
  view, sort or search changes (`docs/requirements.md` → "Sorting").
- Keyboard on the desktop: `n` new note, `/` search, `Esc` ends editing,
  closes menus and panels.

## Feedback and undo

- Changes that remove a note from view (close, reopen, delete) happen
  immediately and offer **Undo** in a snackbar for 5 seconds instead of
  asking for confirmation first.
- Confirmation dialogs only where the user has something to adjust
  (merge order, round 3).

## Visual language

- Colors: Catppuccin flavors mapped to semantic tokens (`app/css/app.css`
  top): surfaces from `base`/`mantle`, text from `text`/`subtext`,
  accent Mauve, overdue = red, done = green, links = blue; the archive
  tints the surfaces with teal.
- Status marks: a **round** button for the note itself, **square**
  checkboxes for tasks inside the text.
- Dates are shown relative where it helps ("Today 08:40", "Yesterday"),
  otherwise as "12 Oct"; the meta line under a note shows the date the
  list is sorted by.
