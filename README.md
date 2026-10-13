# NoteDown

A notes app for Android, iOS and the web — currently in the concept phase.

Every note is a Markdown section and at the same time a to-do: open or
done, with an optional due date. Open notes form the main list, done ones
move to a read-only archive. Notes live in plain Markdown files: one
private file, plus one per group of people notes are shared with.
Notes are edited in place with an Obsidian-style live preview and a
formatting toolbar; holding the + button dictates a new note. A
long-press on a note starts multi-select to close, copy, share, merge
or delete several notes at once.

Notes stay on the device and work offline. Sync between phone, tablet
and the web app, and sharing single notes with other people, run through
an end-to-end encrypted server: it only ever stores encrypted files.
There are no accounts — devices and contacts are connected by scanning a
QR code.

Right now this repository holds the requirements and a clickable
prototype that works out what NoteDown does and how it is operated on
desktop, tablet and phone. The real app comes later.

## Try the prototype

No install, no build — serve the repo:

```bash
python3 scripts/serve.py
```

It prints the addresses: <http://localhost:8000/app/> on this computer,
and `http://<computer-ip>:8000/app/` for a phone in the same network. Resize the window to see the tablet
and phone layouts; ⋮ switches the theme. Dictation needs `localhost` or
https; add `?dictation=demo` to try it without a microphone.

## Where to look

- [`docs/requirements.md`](docs/requirements.md) — the decided scope.
- [`docs/interaction-concept.md`](docs/interaction-concept.md) — how the
  app is operated across devices.
- [`docs/file-format.md`](docs/file-format.md) — the Markdown file.
- [`docs/sync-and-sharing.md`](docs/sync-and-sharing.md) — sync, sharing
  and encryption.
- [`FEATURE_BACKLOG.md`](FEATURE_BACKLOG.md) — ideas not yet decided.

Themes use the [Catppuccin](https://catppuccin.com) palette (MIT);
Markdown rendering uses [marked](https://github.com/markedjs/marked) and
editing [CodeMirror](https://codemirror.net) (both MIT).
