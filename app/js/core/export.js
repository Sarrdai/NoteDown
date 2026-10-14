// Export (docs/requirements.md → "Export"): notes or selected parts as one
// Markdown file, optionally with a table of contents on top and with or
// without the invisible note markers; "All files" packs one such file per
// NoteDown file (private + one per circle) into a ZIP.
import { tableOfContents } from "./query.js";
import { noteMarker } from "./notes-file.js";

/**
 * One export file. `groups` in output order, each { label, items: [{ note, text }] }:
 * `text` is the note's body or a selected part of it; a group with a label (the
 * archive) starts with a rule and the label in bold. `metadata` writes each
 * note's marker before its first part; `toc` puts a linked table of contents
 * with `depth` levels on top (headings link to GitHub-style anchors, text
 * without a heading is listed in italics without a link).
 */
export function exportMarkdown(groups, { toc = false, depth = 2, metadata = false } = {}) {
  const items = groups.flatMap(g => g.items);
  const out = [];
  if (toc && items.length) out.push("**Contents**", tocList(items, depth), "---");
  const seen = new Set();
  for (const g of groups) {
    if (!g.items.length) continue;
    if (g.label) out.push("---", `**${g.label}**`);
    for (const { note, text } of g.items) {
      const marker = metadata && !seen.has(note.id) ? noteMarker(note) + "\n" : "";
      seen.add(note.id);
      out.push(marker + text.trim());
    }
  }
  return out.join("\n\n") + "\n";
}

function tocList(items, depth) {
  const { entries } = tableOfContents(items.map((it, i) => ({ id: String(i), body: it.text.trim() })));
  const slug = anchors();
  const lines = [];
  for (const e of entries) {
    const anchor = e.fromHeading ? slug(e.text) : null;   // every heading takes its anchor, shown or not
    if (e.level > depth) continue;
    const label = e.fromHeading ? `[${escapeLinkText(e.text)}](#${anchor})` : `*${e.text}*`;
    lines.push(`${"  ".repeat(e.level - 1)}- ${label}`);
  }
  return lines.join("\n");
}

/** GitHub-style heading anchors: lower case, punctuation dropped, spaces as "-", repeats numbered. */
export function anchors() {
  const used = new Map();
  return text => {
    const base = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
    const n = used.get(base) || 0;
    used.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
}

const escapeLinkText = s => s.replace(/[[\]]/g, "\\$&");

/** A file name from a circle's name ("Lea, Tom" → "Lea, Tom.md"), unique among `taken`. */
export function exportFileName(name, taken = []) {
  const base = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim() || "Notes";
  let file = `${base}.md`;
  for (let i = 2; taken.includes(file); i++) file = `${base} (${i}).md`;
  return file;
}

// ---------- ZIP (stored, no compression) ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A ZIP archive of text files, [{ name, text }] → Uint8Array. Stored without
 * compression (notes are small), names in UTF-8 (flag bit 11), `date` as the
 * entries' modification time.
 */
export function zipFiles(files, date = new Date()) {
  const enc = new TextEncoder();
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const local = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = enc.encode(f.text), crc = crc32(data);
    const common = [[20, 2], [0x0800, 2], [0, 2], [time, 2], [day, 2], [crc, 4], [data.length, 4], [data.length, 4], [name.length, 2], [0, 2]];
    const head = bytes([[0x04034b50, 4], ...common]);
    local.push(head, name, data);
    central.push(bytes([[0x02014b50, 4], [20, 2], ...common, [0, 2], [0, 2], [0, 2], [0, 4], [offset, 4]]), name);
    offset += head.length + name.length + data.length;
  }
  const size = central.reduce((s, b) => s + b.length, 0);
  const end = bytes([[0x06054b50, 4], [0, 2], [0, 2], [files.length, 2], [files.length, 2], [size, 4], [offset, 4], [0, 2]]);
  const parts = [...local, ...central, end];
  const out = new Uint8Array(parts.reduce((s, b) => s + b.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// Little-endian fields [[value, byteCount], …] → bytes.
function bytes(fields) {
  const out = new Uint8Array(fields.reduce((s, [, n]) => s + n, 0));
  let at = 0;
  for (const [v, n] of fields) for (let i = 0; i < n; i++) out[at++] = (v >>> (8 * i)) & 0xff;
  return out;
}
