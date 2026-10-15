# NoteDown

A notes app for Android, iOS and the web — currently in the concept phase.

Every note is a Markdown section and at the same time a to-do: open or
done, with an optional due date that can remind you on the day. Open notes form the main list, done ones
move to a read-only archive. Notes live in plain Markdown files: one
private file, plus one per group of people notes are shared with;
a People tab next to the table of contents filters the list by person or
group. Besides the usual sort options, notes can be put in a custom order.
The search filters the list and highlights its hits in the notes and the
table of contents; ▲ / ▼ step from hit to hit.
Notes are edited in place with an Obsidian-style live preview and a
formatting toolbar; holding the + button dictates a new note. A
long-press on a note starts multi-select to close, copy, share, merge,
protect or delete several notes at once (protected notes can't be
deleted, and deleting always asks first); a long-press in the table of contents
selects sections, which can be moved together into a new note.
The Export button in the top bar saves the current view, or all files as a ZIP for a local
backup, as Markdown — with or without a table of contents and the hidden
metadata; the selection exports single notes or sections the same way.

Notes stay on the device and work offline. Sync between phone, tablet
and the web app, and sharing single notes with other people, run through
an end-to-end encrypted server: it only ever stores encrypted files.
There are no accounts — devices and contacts are connected by scanning a
QR code.

Right now this repository holds the requirements and a clickable
prototype that works out what NoteDown does and how it is operated on
desktop, tablet and phone. The prototype is turning into the real app:
Android (a Capacitor shell in `mobile/`) and the web come first, with a
Python sync server in `server/`. End-to-end encrypted sync works: turn
it on with the cloud button (Sync & sharing), link further devices by scanning a QR
code (or with the recovery key), add contacts by their code or an
invitation link (verify the latter later by a safety code), and share notes with them from multi-select → Share.

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
