# The notes file

NoteDown keeps all notes — open and closed — in one Markdown file, plus
one file of the same format per set of people notes are shared with
(`docs/sync-and-sharing.md`). The file must stay pleasant to read and edit in any other Markdown editor
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
| `id` | yes | Stable and unique across all files, as notes move between them (no spaces) |
| `status` | yes | `open` or `closed` |
| `created` | yes | Local time `YYYY-MM-DDTHH:MM` |
| `modified` | yes | Local time of the last content change (closing or reopening doesn't count) |
| `due` | no | Date `YYYY-MM-DD` |
| `closed` | when closed | Local time the note was closed |

Unknown attributes are ignored when reading. A marker without `id` gets a
new one; a missing `created`/`modified` falls back to the other.

## Moved notes

When sharing moves a note into another file (`docs/sync-and-sharing.md`),
the old file keeps a marker without body, so a concurrent edit follows
the note instead of reappearing here:

```markdown
<!-- note id=s03 moved=2026-10-13T09:00 -->
```

`moved` is the local time of the move; markers are written after the
notes and dropped 30 days after the move. Other editors don't show them.

## Open points

- How external edits (another editor on the same device) are picked up —
  app phase.
- Times are local without a time zone; enough while everyone using a
  file is in one time zone, not once members of a shared file live in
  different ones.
