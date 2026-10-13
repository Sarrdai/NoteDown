# The notes file

NoteDown keeps all notes — open and closed — in one Markdown file. The
file must stay pleasant to read and edit in any other Markdown editor
(Obsidian, a plain text editor), so the metadata is hidden in one HTML
comment per note, which Markdown renderers don't show.

Implemented in `app/js/core/notes-file.js`, tested in `tests/core.test.mjs`;
`app/sample/notes.md` is a complete example.

## Structure

```markdown
<!-- note id=s01 status=open created=2026-10-13T08:05 modified=2026-10-13T08:40 due=2026-10-13 -->
## Weekly groceries
- [x] Oat milk
- [ ] Coffee beans (the Ethiopian ones)

<!-- note id=s13 status=closed created=2026-10-10T09:00 modified=2026-10-13T07:30 closed=2026-10-13T07:30 -->
## Pay the electricity bill
Done by bank transfer, reference number in the banking app.
```

- A note starts at its marker line `<!-- note … -->` and runs until the
  next marker or the end of the file. Its body is plain Markdown and may
  contain any headings, so the marker — not a heading — is the boundary.
- Text before the first marker is the file's preamble (e.g. a title); it
  is kept unchanged.
- When writing, notes are separated by one blank line and the body is
  trimmed; the order of the notes in the file carries no meaning (the
  app sorts).

## Marker attributes

| Attribute | Required | Value |
|---|---|---|
| `id` | yes | Stable, unique within the file (no spaces) |
| `status` | yes | `open` or `closed` |
| `created` | yes | Local time `YYYY-MM-DDTHH:MM` |
| `modified` | yes | Local time of the last content change (closing or reopening doesn't count) |
| `due` | no | Date `YYYY-MM-DD` |
| `closed` | when closed | Local time the note was closed |

Unknown attributes are ignored when reading. A marker without `id` gets a
new one; a missing `created`/`modified` falls back to the other.

## Open points

- Where the file lives on each platform, and how external edits (another
  editor, a sync tool) are picked up — app phase.
- Times are local without a time zone; enough while the file is used in
  one time zone.
