"""Renders the notes of a shared file as HTML for a TRMNL display (backlog #49): the first-generation TRMNL shows
800×480 pixels in black and white, so everything is solid black on white, no greys. TRMNL renders the markup in its
cloud and sends the picture to the device; the markup carries its own styles and needs no framework classes.

Nothing is measured in a browser here: the height of every row is estimated from its length, so the screen is
filled column by column and what doesn't fit is cut off with a "+n more" line instead of overflowing."""

import html
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from .notes import Note, NotesFile, shown_notes

# TRMNL's four layouts: the full screen and the parts of a mashup (several plugins on one screen)
LAYOUTS = {"full": (800, 480), "half_horizontal": (800, 240), "half_vertical": (400, 480), "quadrant": (400, 240)}

PAD = 16          # page margin
BAR = 36          # the bar at the bottom: app, circle, time of the picture
GAP = 16          # between notes and columns
CHAR = 0.5        # average character width in em of a sans-serif font, a little on the safe side

TEXTS = {
    "en": {"today": "Today", "tomorrow": "Tomorrow", "yesterday": "Yesterday", "more": "+{n} more",
           "more_notes": "+{n} more notes", "updated": "Updated {t}", "empty": "Nothing shared yet",
           "empty_hint": "Share a note with this contact in NoteDown to show it here.",
           "connect": "Connect NoteDown",
           "connect_hint": "Open this plugin's settings in TRMNL and add it as a contact in NoteDown.",
           "reconnect": "Reconnect NoteDown",
           "reconnect_hint": "TRMNL's connection changed. Install the plugin again and share your notes anew.",
           "days": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
           "months": ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]},
    "de": {"today": "Heute", "tomorrow": "Morgen", "yesterday": "Gestern", "more": "+{n} weitere",
           "more_notes": "+{n} weitere Notizen", "updated": "Stand {t}", "empty": "Noch nichts geteilt",
           "empty_hint": "Teile in NoteDown eine Notiz mit diesem Kontakt, um sie hier zu zeigen.",
           "connect": "NoteDown verbinden",
           "connect_hint": "Öffne die Einstellungen dieses Plugins in TRMNL und füge es in NoteDown als Kontakt hinzu.",
           "reconnect": "NoteDown neu verbinden",
           "reconnect_hint": "Die Verbindung zu TRMNL hat sich geändert. Installiere das Plugin neu und teile deine Notizen erneut.",
           "days": ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"], "months": []},
}

# font size and line height in px per kind of row
FONTS = {"title": (24, 30), "heading": (17, 24), "text": (20, 26), "table": (16, 22)}


@dataclass
class Row:
    kind: str            # "heading", "task", "item", "number", "text", "table", "gap"
    html: str
    plain: str = ""      # the visible text, for estimating its height
    indent: int = 0      # nesting level of list items
    state: str = ""      # task state: open, done, progress, cancelled; the number of a numbered item
    rows: int = 0        # table rows


@dataclass
class Card:
    title: str           # html, empty for a note without heading
    title_plain: str
    due: str             # html of the due badge or empty
    rows: list[Row]


def render(notes_file: NotesFile, *, circle: str, now: datetime, layout: str = "full", lang: str = "en",
           message: str | None = None) -> str:
    """The markup of one TRMNL layout. `now` is the user's local time; `message` (a key of TEXTS: "connect",
    "reconnect") shows that instead of the notes."""
    width, height = LAYOUTS[layout]
    texts = TEXTS.get(lang, TEXTS["en"])
    cards = [] if message else [card(n, now.date(), texts) for n in shown_notes(notes_file)]
    area = (width - 2 * PAD, height - BAR - 2 * PAD)
    if not cards:
        key = message or "empty"
        body = (f'<div class="empty"><div class="empty-title">{texts[key]}</div>'
                f'<div class="empty-hint">{texts[key + "_hint"]}</div></div>')
        hidden = 0
    else:
        body, hidden = flow(cards, area, 2 if width >= 600 else 1, texts)
    more = f' · {texts["more_notes"].format(n=hidden)}' if hidden else ""
    bar = (f'<div class="bar"><span class="app">NoteDown</span><span class="circle">{esc(circle)}{more}</span>'
           f'<span class="time">{texts["updated"].format(t=now.strftime("%H:%M"))}</span></div>')
    return (f'<div class="nd nd-{layout}" style="width:{width}px;height:{height}px">{STYLE}'
            f'<div class="page" style="height:{area[1]}px">{body}</div>{bar}</div>')


# --- notes to rows -------------------------------------------------------------------------------------------------

HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
TASK = re.compile(r"^(\s*)[-*+]\s+\[([ xX/-])\]\s*(.*)$")
ITEM = re.compile(r"^(\s*)[-*+]\s+(.*)$")
NUMBER = re.compile(r"^(\s*)(\d+)[.)]\s+(.*)$")
TABLE = re.compile(r"^\s*\|.*\|\s*$")
TABLE_RULE = re.compile(r"^\s*\|[\s:|-]+\|\s*$")
IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
LABEL = re.compile(r"(^|\s)#[^\s#]+")
TASK_DUE = re.compile(r"\s*📅\s*(\d{4}-\d{2}-\d{2})\s*$")
DONE_DATE = re.compile(r"\s*✅\s*\d{4}-\d{2}-\d{2}")
COUNTER_STEPS = re.compile(r"\s*\[(?:\s*(?:[-+]\d[\d.,:]*|⏱\d*))+\s*\]")
DUE_TEXT = " Sat 24 Oct"   # a due badge, as text of about its width
STATES = {" ": "open", "x": "done", "X": "done", "/": "progress", "-": "cancelled"}


def card(note: Note, today: date, texts: dict) -> Card:
    lines = note.body.splitlines()
    title, title_plain = "", ""
    if lines and (m := HEADING.match(lines[0])):
        title, title_plain = inline(m.group(2))
        lines = lines[1:]
    rows: list[Row] = []
    table: list[list[str]] = []
    for line in lines + [""]:
        if TABLE.match(line):
            if not TABLE_RULE.match(line):
                table.append([inline(c)[0] for c in line.strip().strip("|").split("|")])
            continue
        if table:
            rows.append(table_row(table))
            table = []
        if not line.strip():
            if rows and rows[-1].kind != "gap":
                rows.append(Row("gap", ""))
            continue
        if m := HEADING.match(line):
            text, plain = inline(m.group(2))
            if plain:
                rows.append(Row("heading", text, plain))
        elif m := TASK.match(line):
            rest, due = split_due(m.group(3), today, texts)
            text, plain = inline(rest)
            rows.append(Row("task", text + due, plain + (DUE_TEXT if due else ""), level(m.group(1)),
                            STATES[m.group(2)]))
        elif m := ITEM.match(line):
            text, plain = inline(m.group(2))
            if plain:
                rows.append(Row("item", text, plain, level(m.group(1))))
        elif m := NUMBER.match(line):
            text, plain = inline(m.group(3))
            rows.append(Row("number", text, plain, level(m.group(1)), m.group(2)))
        else:
            text, plain = inline(line)
            if plain:   # a line of labels or an embedded image only shows nothing
                rows.append(Row("text", text, plain))
    while rows and rows[-1].kind == "gap":
        rows.pop()
    due = badge(date.fromisoformat(note.due), today, texts) if note.due else ""
    return Card(title, title_plain, due, rows)


def table_row(cells: list[list[str]]) -> Row:
    head, *body = cells
    out = "".join(f"<th>{c}</th>" for c in head)
    out = f"<tr>{out}</tr>" + "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in body)
    return Row("table", f'<table>{out}</table>', rows=len(cells))


def level(indent: str) -> int:
    return len(indent.replace("\t", "    ")) // 2


def split_due(text: str, today: date, texts: dict) -> tuple[str, str]:
    """A task's due date (Obsidian Tasks' `📅 YYYY-MM-DD` at the end of the line) as a badge."""
    text = DONE_DATE.sub("", text)
    m = TASK_DUE.search(text)
    if not m:
        return text, ""
    return text[:m.start()], " " + badge(date.fromisoformat(m.group(1)), today, texts)


def badge(day: date, today: date, texts: dict) -> str:
    return f'<span class="due{" over" if day < today else ""}">{day_label(day, today, texts)}</span>'


def day_label(day: date, today: date, texts: dict) -> str:
    near = {today: "today", today + timedelta(days=1): "tomorrow", today - timedelta(days=1): "yesterday"}
    if day in near:
        return texts[near[day]]
    weekday = texts["days"][day.weekday()]
    if texts["months"]:
        return f"{weekday} {day.day} {texts['months'][day.month - 1]}"
    return f"{weekday} {day.day}.{day.month}."


def inline(text: str) -> tuple[str, str]:
    """One line of Markdown as html, and its visible text. Images, labels, a counter's steps and a
    done date don't show; links show their text."""
    text = IMAGE.sub("", text)
    text = DONE_DATE.sub("", text)
    text = COUNTER_STEPS.sub("", text)
    text = LABEL.sub(r"\1", text).strip()
    text = esc(text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"(?<![\w*])[*_](?!\s)(.+?)(?<!\s)[*_](?![\w*])", r"<i>\1</i>", text)
    text = re.sub(r"`(.+?)`", r"<code>\1</code>", text)
    text = re.sub(r"==(.+?)==", r"<mark>\1</mark>", text)
    return text, html.unescape(re.sub(r"<[^>]+>", "", text))


def esc(text: str) -> str:
    return html.escape(text, quote=False)


# --- estimating heights --------------------------------------------------------------------------------------------

INDENT = 24      # per nesting level
MARKER = 26      # the checkbox or bullet in front of an item


def lines(text: str, width: int, font: int) -> int:
    """How many lines `text` takes at `width` px, wrapped at spaces like the browser does."""
    per_line = max(6, int(width / (font * CHAR)))
    count, used = 1, 0
    for word in text.split():
        if used and used + 1 + len(word) > per_line:
            count, used = count + 1, 0
        used = used + 1 + len(word) if used else len(word)
        while used > per_line:      # a word longer than the line breaks inside
            count, used = count + 1, used - per_line
    return count


def row_height(row: Row, width: int) -> int:
    if row.kind == "gap":
        return 8
    if row.kind == "table":
        return row.rows * FONTS["table"][1] + 6
    if row.kind == "heading":
        font, line = FONTS["heading"]
        return lines(row.plain, width, font) * line + 6
    font, line = FONTS["text"]
    offset = row.indent * INDENT + (MARKER if row.kind != "text" else 0)
    return lines(row.plain, width - offset, font) * line + 2


def title_height(c: Card, width: int) -> int:
    if not c.title:
        return 0
    font, line = FONTS["title"]
    return lines(c.title_plain + (DUE_TEXT if c.due else ""), width, font) * line + 6


def fill(c: Card, width: int, room: int, texts: dict, start: int = 0, more: bool = True) -> tuple[list[str], int, int]:
    """The rows of a card from `start` that fit into `room` px: their html, the height used and the index of the
    first row left out (len(rows) when all fit). With `more`, the card ends here: a paragraph or item that fits only
    partly shows its first lines, and what is left out is counted in a "+n more" line."""
    out, used, i = [], 0, start
    while i < len(c.rows) and used + row_height(c.rows[i], width) <= room:
        out.append(row_html(c.rows[i]))
        used += row_height(c.rows[i], width)
        i += 1
    if i == len(c.rows):
        return out, used, i
    while out and c.rows[i - 1].kind in ("heading", "gap"):    # no heading at the end of a column
        i -= 1
        used -= row_height(c.rows[i], width)
        out.pop()
    if not more:
        return out, used, i
    line = FONTS["text"][1]

    def hidden_from(k: int) -> int:
        return sum(1 for r in c.rows[k:] if r.kind not in ("gap", "heading"))

    while out and used + line > room:     # room for the "+n more" line
        i -= 1
        used -= row_height(c.rows[i], width)
        out.pop()
    row = c.rows[i]
    if row.kind in ("text", "task", "item", "number"):
        reserve = line if hidden_from(i + 1) else 0
        fit = (room - used - reserve - 2) // line
        if fit >= 1:
            out.append(row_html(row, clamp=fit))
            used += fit * line + 2
            i += 1
    if hidden_from(i) and used + line <= room:
        out.append(f'<div class="more">{texts["more"].format(n=hidden_from(i))}</div>')
        used += line
    return out, used, i


def row_html(row: Row, clamp: int = 0) -> str:
    pad = f' style="margin-left:{row.indent * INDENT}px"' if row.indent else ""
    cut = f' style="-webkit-line-clamp:{clamp}"' if clamp else ""
    if row.kind == "gap":
        return '<div class="gap"></div>'
    if row.kind in ("heading", "table"):
        return f'<div class="{row.kind}">{row.html}</div>'
    if row.kind == "text":
        return f'<div class="text{" clamp" if clamp else ""}"{cut}>{row.html}</div>'
    marker = {"task": '<span class="box"></span>', "item": '<span class="dot"></span>',
              "number": f'<span class="num">{row.state}.</span>'}[row.kind]
    state = f" {row.state}" if row.kind == "task" else ""
    txt = f'<span class="txt clamp"{cut}>' if clamp else '<span class="txt">'
    return f'<div class="row{state}"{pad}>{marker}{txt}{row.html}</span></div>'


def title_html(c: Card) -> str:
    return f'<div class="title"><span>{c.title}</span>{c.due}</div>' if c.title else ""


# --- the variants --------------------------------------------------------------------------------------------------

def flow(cards: list[Card], area: tuple[int, int], columns: int, texts: dict) -> tuple[str, int]:
    """The notes one after another, flowing over the columns like a newspaper; a note goes on in the next column."""
    width = (area[0] - GAP * (columns - 1)) // columns
    cols: list[list[str]] = [[] for _ in range(columns)]
    col, used, shown = 0, 0, 0
    for c in cards:
        head = title_height(c, width) + (FONTS["text"][1] if c.rows else 0) + (GAP if used else 0)
        if used and used + head > area[1]:
            col, used = col + 1, 0
        if col >= columns:
            break
        if used:
            cols[col].append('<div class="sep"></div>')
            used += GAP
        cols[col].append(title_html(c) if c.title else (f'<div class="title">{c.due}</div>' if c.due else ""))
        used += title_height(c, width)
        start = 0
        while True:
            last = col + 1 >= columns
            out, h, start = fill(c, width, area[1] - used, texts, start, more=last)
            cols[col].extend(out)
            used += h
            if last or start >= len(c.rows):
                break
            col, used = col + 1, 0
        shown += 1
    body = "".join(f'<div class="col" style="width:{width}px">{"".join(x)}</div>' for x in cols)
    return f'<div class="cols">{body}</div>', len(cards) - shown


STYLE = """<style>
.nd{position:relative;box-sizing:border-box;overflow:hidden;background:#fff;color:#000;
  font-family:Inter,"Helvetica Neue",Arial,"DejaVu Sans",sans-serif;font-size:20px;line-height:26px}
.nd *{box-sizing:border-box}
.nd .page{padding:16px;height:100%;overflow:hidden;box-sizing:content-box}
.nd .cols{display:flex;gap:16px;height:100%;align-items:flex-start}
.nd .col{flex:none;overflow:hidden;max-height:100%}
.nd .title{display:flex;align-items:baseline;gap:10px;font-size:24px;line-height:30px;font-weight:700;margin-bottom:6px}
.nd .title>span:first-child{flex:1}
.nd .heading{font-size:17px;line-height:24px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;margin-top:6px}
.nd .row{display:flex;align-items:flex-start;margin-bottom:2px}
.nd .text{margin-bottom:2px}
.nd .txt{flex:1}
.nd .clamp{display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}
.nd .box{flex:none;width:17px;height:17px;border:2.5px solid #000;border-radius:3px;margin:4px 9px 0 0;position:relative}
.nd .done .box{background:#000}
.nd .progress .box{background:linear-gradient(135deg,#000 50%,#fff 50%)}
.nd .cancelled .box::after{content:"";position:absolute;left:1px;right:1px;top:5px;height:2.5px;background:#000}
.nd .done .txt,.nd .cancelled .txt{text-decoration:line-through}
.nd .dot{flex:none;width:7px;height:7px;border-radius:50%;background:#000;margin:10px 19px 0 0}
.nd .num{flex:none;width:26px;font-weight:700}
.nd .gap{height:8px}
.nd .more{font-style:italic;font-weight:700}
.nd .due{flex:none;font-size:16px;line-height:20px;font-weight:700;border:2px solid #000;border-radius:5px;
  padding:0 6px;white-space:nowrap;vertical-align:2px}
.nd .due.over{background:#000;color:#fff}
.nd mark{background:#000;color:#fff;padding:0 3px}
.nd code{font-family:"DejaVu Sans Mono",monospace;font-size:17px}
.nd table{border-collapse:collapse;table-layout:fixed;width:100%;font-size:16px;line-height:22px;margin:3px 0}
.nd th{text-align:left;border-bottom:2px solid #000}
.nd th,.nd td{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:8px}
.nd .sep{height:14px;border-top:2px solid #000;margin-top:2px}
.nd .empty{height:100%;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:0 40px}
.nd .empty-title{font-size:28px;line-height:36px;font-weight:700;margin-bottom:8px}
.nd .bar{position:absolute;left:0;right:0;bottom:0;height:36px;background:#000;color:#fff;display:flex;
  align-items:center;gap:16px;padding:0 16px;font-size:17px;line-height:36px}
.nd .bar .app{font-weight:700}
.nd .bar .circle{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style>"""
