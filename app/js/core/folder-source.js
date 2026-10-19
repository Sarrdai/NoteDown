// Folder sources (docs/requirements.md → "Folder sources"): a folder on an Android device that another app
// writes notes into as files, e.g. the Pebble app's recordings from the Index ring. The Android app reads each
// new file into a private note marked with the source (`source=<id>`) and then deletes the file. The source's
// name lives in the private file (`<!-- source … -->`), so every device shows it in the People overview; which
// folder belongs to it is a setting of the device that reads it.
import { timestamp } from "./notes-file.js";

/** Circle keys of folder sources start with this; like the news' "@news" they can't be member IDs. */
export const SOURCE_PREFIX = "@folder:";

/** The People filter key of a source. */
export const sourceKey = id => SOURCE_PREFIX + id;

/** The source ID of a filter key, or null when the key is no source. */
export const sourceIdOf = key => (typeof key === "string" && key.startsWith(SOURCE_PREFIX) ? key.slice(SOURCE_PREFIX.length) : null);

/** A new source ID. */
export function newSourceId() {
  return "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** The files a folder may hold for us: Markdown and plain text. */
export const isNoteFile = name => /\.(md|markdown|txt)$/i.test(name);

/**
 * A file's note: its text without a leading YAML front matter block (which Obsidian-style writers such as the
 * Pebble app put there), and its creation time — the front matter's `created` when it is a valid time (a time
 * without a zone is the device's local time), else the file's last change (`modifiedMs`, else now).
 * → { body, created } with `body` "" for a file without text.
 */
export function fileNote(text, modifiedMs) {
  let body = String(text).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  let created = null;
  const front = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(body);
  if (front) {
    body = body.slice(front[0].length);
    const m = /^created:[ \t]*["']?([^"'\n]+?)["']?[ \t]*$/m.exec(front[1]);
    const d = m ? new Date(m[1].trim()) : null;
    if (d && !Number.isNaN(d.getTime())) created = timestamp(d);
  }
  if (!created) created = timestamp(Number.isFinite(modifiedMs) && modifiedMs > 0 ? new Date(modifiedMs) : new Date());
  return { body: body.trim(), created };
}
