# NoteDown

A notes app for Android, iOS and the web — currently in the concept phase.

Every note is a Markdown section and at the same time a to-do: open or
done, with an optional due date. Open notes form the main list, done ones
move to a read-only archive. All notes live in one plain Markdown file.

Right now this repository holds the requirements and a clickable
prototype that works out what NoteDown does and how it is operated on
desktop, tablet and phone. The real app comes later.

## Try the prototype

No install, no build — serve the repo with any static file server:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000/app/> (on a phone in the same network:
`http://<computer-ip>:8000/app/`). Resize the window to see the tablet
and phone layouts; ⋮ switches the theme and the design variants still
under discussion.

## Where to look

- [`docs/requirements.md`](docs/requirements.md) — the decided scope.
- [`docs/interaction-concept.md`](docs/interaction-concept.md) — how the
  app is operated across devices.
- [`docs/file-format.md`](docs/file-format.md) — the Markdown file.
- [`FEATURE_BACKLOG.md`](FEATURE_BACKLOG.md) — ideas not yet decided.

Themes use the [Catppuccin](https://catppuccin.com) palette (MIT);
Markdown rendering uses [marked](https://github.com/markedjs/marked) (MIT).
