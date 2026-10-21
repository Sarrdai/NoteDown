#!/usr/bin/env python3
"""Writes the TRMNL screens (backlog #49) for the sample notes as HTML pages, one per variant, layout and case,
for screenshots: python3 scripts/trmnl-preview.py <out dir>. The notes come from app/sample/notes.md (CLAUDE.md)."""

import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

from notedown_server.trmnl.notes import parse  # noqa: E402
from notedown_server.trmnl.render import LAYOUTS, VARIANTS, render  # noqa: E402

# the notes a circle shares with the display: one long note, and a kitchen display with several
CASES = {"one": ["s03"], "several": ["s01", "s09", "s12", "s07", "s04"]}
NOW = datetime(2026, 10, 13, 8, 45)   # the sample's "today"


def main(out: Path) -> None:
    sample = parse((ROOT / "app/sample/notes.md").read_text())
    out.mkdir(parents=True, exist_ok=True)
    for case, ids in CASES.items():
        notes_file = type(sample)(notes=[n for n in sample.notes if n.id in ids], order=ids)
        for variant in VARIANTS:
            for layout in LAYOUTS:
                for lang in ("en", "de"):
                    markup = render(notes_file, circle="Alex & Lea", now=NOW, layout=layout, variant=variant,
                                    lang=lang)
                    page = f'<!doctype html><meta charset="utf-8"><body style="margin:0">{markup}</body>'
                    (out / f"{variant}-{case}-{layout}-{lang}.html").write_text(page)


if __name__ == "__main__":
    main(Path(sys.argv[1] if len(sys.argv) > 1 else "trmnl-preview"))
