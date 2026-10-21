"""Reads a NoteDown notes file (docs/file-format.md) as far as the display needs it: the notes, the members' names
and the circle's custom order. Read-only; app/js/core/notes-file.js is the full implementation."""

import re
from dataclasses import dataclass, field
from urllib.parse import unquote

MARKER = re.compile(r"^<!--\s*(note|device|member|contact|news|source|order)\b(.*?)-->\s*$")
ATTR = re.compile(r"(\w+)=(\S+)")


@dataclass
class Note:
    id: str
    status: str
    modified: str
    body: str
    due: str | None = None


@dataclass
class NotesFile:
    notes: list[Note] = field(default_factory=list)
    members: dict[str, str] = field(default_factory=dict)   # identity id → display name
    order: list[str] = field(default_factory=list)          # note ids of the Shared shelves, shelves (~…) left out


def parse(text: str) -> NotesFile:
    result = NotesFile()
    current: tuple[dict, list[str]] | None = None

    def close():
        if current is None:
            return
        attrs, lines = current
        # moved and purged markers have no body; deleted ones live in the private file only
        if attrs.get("id") and not ({"moved", "purged", "deleted"} & attrs.keys()):
            status = attrs.get("status", "open")
            result.notes.append(Note(attrs["id"], status if status in ("open", "closed", "permanent") else "open",
                                     attrs.get("modified") or attrs.get("created") or "", "\n".join(lines).strip(),
                                     attrs.get("due")))

    for line in text.splitlines():
        match = MARKER.match(line.strip())
        if not match:
            if current is not None:
                current[1].append(line)
            continue
        close()
        current = None
        kind, attrs = match.group(1), dict(ATTR.findall(match.group(2)))
        if kind == "note":
            current = (attrs, [])
        elif kind == "member" and "id" in attrs:
            result.members[attrs["id"]] = unquote(attrs.get("name", ""))
        elif kind == "order":
            result.order = [i for i in attrs.get("ids", "").split(",") if i and not i.startswith("~")]
    close()
    return result


def shown_notes(notes_file: NotesFile) -> list[Note]:
    """The notes the display shows: open and permanent ones, in the circle's custom order, the rest by last edit."""
    notes = [n for n in notes_file.notes if n.status != "closed"]
    position = {note_id: i for i, note_id in enumerate(notes_file.order)}
    ordered = sorted((n for n in notes if n.id in position), key=lambda n: position[n.id])
    rest = sorted((n for n in notes if n.id not in position), key=lambda n: n.modified, reverse=True)
    return ordered + rest
