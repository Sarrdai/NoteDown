"""The TRMNL screen (backlog #49): reading the shared file and rendering it, with the sample notes."""

from datetime import date, datetime
from pathlib import Path

import pytest

from notedown_server.trmnl.notes import NotesFile, parse, shown_notes
from notedown_server.trmnl.render import LAYOUTS, TEXTS, card, inline, lines, render

SAMPLE = parse((Path(__file__).resolve().parents[2] / "app/sample/notes.md").read_text())
NOW = datetime(2026, 10, 13, 8, 45)


def circle(*ids: str, order: list[str] | None = None) -> NotesFile:
    return NotesFile(notes=[n for n in SAMPLE.notes if n.id in ids], order=order or [])


def note(note_id: str):
    return next(n for n in SAMPLE.notes if n.id == note_id)


def test_parse_reads_notes_members_and_order():
    text = (
        "<!-- note id=a status=open created=2026-10-01T08:00Z modified=2026-10-02T08:00Z due=2026-10-05 -->\n"
        "## One\n- [ ] task\n\n"
        "<!-- note id=b status=closed created=2026-10-01T08:00Z modified=2026-10-03T08:00Z -->\n## Two\n\n"
        "<!-- note id=c moved=2026-10-03T09:00Z to=x+y -->\n"
        "<!-- member id=U2Ft name=Sam%20K -->\n"
        "<!-- order modified=2026-10-04T09:00Z ids=~Home,b,a -->\n"
    )
    parsed = parse(text)
    assert [(n.id, n.status, n.due) for n in parsed.notes] == [("a", "open", "2026-10-05"), ("b", "closed", None)]
    assert parsed.notes[0].body == "## One\n- [ ] task"
    assert parsed.members == {"U2Ft": "Sam K"}
    assert parsed.order == ["b", "a"]


def test_shown_notes_leave_closed_out_and_follow_the_shared_order():
    notes_file = circle("s01", "s05", "s07", "s13", order=["s07"])
    # s07 by the order, then by last edit: s01 (13 Oct), s05 (11 Oct, permanent); s13 is closed
    assert [n.id for n in shown_notes(notes_file)] == ["s07", "s01", "s05"]


def test_braces_do_not_reach_liquid():
    # TRMNL parses the markup as Liquid: a note's {{ … }} or {% … %} must stay text
    html_, plain = inline("Order the {{ cake }} {% raw %}")
    assert "{" not in html_ and "}" not in html_
    assert plain == "Order the {{ cake }} {% raw %}"


def test_inline_drops_what_the_display_cannot_use():
    assert inline("Order the cake #shopping")[1] == "Order the cake"
    assert inline("P-2041 Website relaunch: 23,5 h [-4 -1 +1 +8 ⏱15]")[1] == "P-2041 Website relaunch: 23,5 h"
    assert inline("Last time: [Move the dentist appointment](note:s16)")[1] == "Last time: Move the dentist appointment"
    assert inline("![Tram 28 in Alfama](https://images.example.org/lisbon/tram-28.jpg)")[1] == ""
    html_text, plain = inline("The deadline was extended, but ==the accountant wants the papers this week==.")
    assert "<mark>the accountant wants the papers this week</mark>" in html_text
    assert plain.endswith("this week.")
    assert inline("a <b> & c")[0] == "a &lt;b&gt; &amp; c"


def test_card_reads_tasks_with_states_and_due_dates():
    c = card(note("s03"), NOW.date(), TEXTS["en"])
    assert c.title == "Trip to Lisbon"
    assert '<span class="due">Sat 17 Oct</span>' == c.due
    tasks = [(r.state, r.plain) for r in c.rows if r.kind == "task"]
    assert tasks[0] == ("done", "Book flights")
    assert tasks[1][0] == "open" and tasks[1][1].startswith("Reserve the apartment in Alfama")
    assert ("cancelled", "Power adapter? (no, same plug type)") in tasks
    assert any(r.kind == "item" and r.indent == 1 for r in c.rows)   # the seats under "Book flights"
    assert not any("tram-28" in r.html for r in c.rows)              # the image is left out
    groceries = card(note("s01"), NOW.date(), TEXTS["en"])
    assert groceries.rows[0].plain == "Oat milk"                      # the done date is left out
    assert groceries.rows[-1].kind == "task"                          # the label line shows nothing


def test_due_labels_are_relative_near_today_and_localised():
    car = card(note("s12"), NOW.date(), TEXTS["de"])
    assert car.due == '<span class="due">Sa 31.10.</span>'
    assert "Sa 24.10." in car.rows[0].html
    overdue = card(note("s04"), NOW.date(), TEXTS["en"])
    assert overdue.due == '<span class="due over">Sat 10 Oct</span>'
    assert card(note("s01"), NOW.date(), TEXTS["de"]).due == '<span class="due">Heute</span>'
    assert card(note("s01"), date(2026, 10, 12), TEXTS["en"]).due == '<span class="due">Tomorrow</span>'


def test_lines_wraps_at_spaces():
    assert lines("short", 300, 20) == 1
    assert lines("word " * 12, 300, 20) == 2          # 30 characters per line
    assert lines("x" * 75, 300, 20) == 3              # a long word breaks inside


@pytest.mark.parametrize("layout", LAYOUTS)
def test_every_layout_renders(layout):
    markup = render(circle("s01", "s09", "s12", "s07", "s04", "s13"), circle="Alex & Lea", now=NOW, layout=layout)
    assert f'class="nd nd-{layout}"' in markup
    assert "Weekly groceries" in markup                  # the newest note always shows
    assert "Pay the electricity bill" not in markup      # closed
    assert "Alex &amp; Lea" in markup and "Updated 08:45" in markup


def test_what_does_not_fit_is_counted():
    notes_file = circle("s01", "s09", "s12", "s07", "s04")
    quadrant = render(notes_file, circle="Alex & Lea", now=NOW, layout="quadrant")
    assert "more notes" in quadrant
    long_note = render(circle("s03"), circle="Alex & Lea", now=NOW, layout="half_vertical")
    assert '<div class="more">+' in long_note


def test_an_empty_circle_says_how_to_fill_it():
    markup = render(NotesFile(), circle="Alex", now=NOW, lang="de")
    assert "Noch nichts geteilt" in markup
