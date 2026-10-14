# NoteDown

A notes app for Android, iOS and the web — currently in the concept phase.

Every note is a Markdown section and at the same time a to-do: open or
done, with an optional due date. Open notes form the main list, done ones
move to a read-only archive. Notes live in plain Markdown files: one
private file, plus one per group of people notes are shared with.
Notes are edited in place with an Obsidian-style live preview and a
formatting toolbar; holding the + button dictates a new note. A
long-press on a note starts multi-select to close, copy, share, merge
or delete several notes at once; a long-press in the table of contents
selects sections, which can be moved together into a new note.

Notes stay on the device and work offline. Sync between phone, tablet
and the web app, and sharing single notes with other people, run through
an end-to-end encrypted server: it only ever stores encrypted files.
There are no accounts — devices and contacts are connected by scanning a
QR code.

Right now this repository holds the requirements and a clickable
prototype that works out what NoteDown does and how it is operated on
desktop, tablet and phone. The prototype is turning into the real app:
Android (a Capacitor shell in `mobile/`) and the web come first, with a
Python sync server in `server/`. The first milestone, end-to-end
encrypted sync between your own devices, works: turn it on under ⋮ →
Sync & sharing and link further devices by scanning a QR code (or with the
recovery key).

## Try the prototype

No install, no build — serve the repo:

```bash
python3 scripts/serve.py
```

It prints the addresses: <http://localhost:8000/app/> on this computer,
and `http://<computer-ip>:8000/app/` for a phone in the same network. Resize the window to see the tablet
and phone layouts; ⋮ switches the theme. The prototype keeps real notes
and starts with a welcome note; add `?sample` to the address to replace
them with the sample notes. Dictation needs `localhost` or https; add
`?dictation=demo` to try it without a microphone.

## Where to look

- [`docs/requirements.md`](docs/requirements.md) — the decided scope.
- [`docs/interaction-concept.md`](docs/interaction-concept.md) — how the
  app is operated across devices.
- [`docs/file-format.md`](docs/file-format.md) — the Markdown file.
- [`docs/sync-and-sharing.md`](docs/sync-and-sharing.md) — sync, sharing
  and encryption.
- [`docs/server-api.md`](docs/server-api.md) — the protocol between app
  and server.
- [`docs/operations.md`](docs/operations.md) — the live test setup:
  hosting, deployment, one-time setup.
- [`FEATURE_BACKLOG.md`](FEATURE_BACKLOG.md) — ideas not yet decided.

Themes use the [Catppuccin](https://catppuccin.com) palette (MIT);
Markdown rendering uses [marked](https://github.com/markedjs/marked),
editing [CodeMirror](https://codemirror.net) (both MIT), and the Android
app [Capacitor](https://capacitorjs.com) (MIT).
