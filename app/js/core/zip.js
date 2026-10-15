// Reads a ZIP archive (e.g. a Google Takeout export) in the browser, without
// a library: the central directory lists the entries, stored ones are copied
// and deflated ones go through the platform's DecompressionStream. Enough for
// the archives NoteDown reads; no ZIP64, encryption or multi-part archives.

const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;

/**
 * The entries of an archive: [{ name, size, read() → Promise<Uint8Array> }],
 * folders left out. Throws on a file that isn't a ZIP archive.
 */
export function zipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  // The end record sits in the last 64 KB (its comment can be that long).
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === EOCD) { end = i; break; }
  }
  if (end < 0) throw new Error("not a zip archive");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const utf8 = new TextDecoder(), latin = new TextDecoder("latin1");
  const out = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== CENTRAL) throw new Error("broken zip directory");
    const flags = view.getUint16(at + 8, true), method = view.getUint16(at + 10, true);
    const packed = view.getUint32(at + 20, true), size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true), extraLen = view.getUint16(at + 30, true), commentLen = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const name = (flags & 0x0800 ? utf8 : latin).decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    out.push({ name, size, read: () => readEntry(bytes, view, offset, method, packed) });
  }
  return out;
}

async function readEntry(bytes, view, offset, method, packed) {
  if (view.getUint32(offset, true) !== LOCAL) throw new Error("broken zip entry");
  const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
  const data = bytes.subarray(start, start + packed);
  if (method === 0) return data.slice();
  if (method !== 8) throw new Error("unsupported zip compression");
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
