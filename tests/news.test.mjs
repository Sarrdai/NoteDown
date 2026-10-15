// News feed state (app/js/core/news.js) and its markers in the notes file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newsNotes, freshCount, markNews, pruneNews } from "../app/js/core/news.js";
import { parseNotesFile, serializeNotesFile } from "../app/js/core/notes-file.js";
import { mergeNotesFiles } from "../app/js/core/merge.js";

const posts = [
  { id: "p3", created: "2026-10-15T09:00:00Z", modified: "2026-10-15T09:00:00Z", body: "## Three" },
  { id: "p2", created: "2026-10-14T16:00:00Z", modified: "2026-10-15T08:30:00Z", body: "## Two" },
  { id: "p1", created: "2026-10-14T10:00:00Z", modified: "2026-10-14T10:00:00Z", body: "## One" },
];

test("a post without marker is new, an edited one updated, a seen one plain", () => {
  const marks = [{ id: "p2", seen: "2026-10-14T16:00:00Z" }, { id: "p1", seen: "2026-10-14T10:00:00Z" }];
  const notes = newsNotes(posts, marks);
  assert.deepEqual(notes.map(n => [n.id, n.fresh, n.status]), [["p3", "new", "open"], ["p2", "updated", "open"], ["p1", null, "open"]]);
  assert.equal(freshCount(notes), 2);
  assert.ok(notes.every(n => n.news && n.due === null));
});

test("archived posts are closed, deleted ones gone — until the post is edited", () => {
  const marks = [{ id: "p1", seen: "2026-10-14T10:00:00Z", status: "archived" }, { id: "p3", seen: "2026-10-15T09:00:00Z", status: "deleted" }];
  assert.deepEqual(newsNotes(posts, marks).map(n => [n.id, n.status, n.fresh]), [["p2", "open", "new"], ["p1", "closed", null]]);
  const edited = posts.map(p => (p.id === "p3" ? { ...p, modified: "2026-10-16T07:00:00Z" } : p));
  assert.deepEqual(newsNotes(edited, marks).find(n => n.id === "p3").fresh, "updated");
});

test("markNews records the current version and the status", () => {
  let marks = markNews([], posts, ["p3", "p2"]);
  assert.deepEqual(marks, [{ id: "p3", seen: "2026-10-15T09:00:00Z" }, { id: "p2", seen: "2026-10-15T08:30:00Z" }]);
  marks = markNews(marks, posts, ["p2"], "archived");
  assert.deepEqual(marks[1], { id: "p2", seen: "2026-10-15T08:30:00Z", status: "archived" });
  // Seeing keeps a current status; reopening drops it.
  assert.deepEqual(markNews(marks, posts, ["p2"])[1], marks[1]);
  assert.deepEqual(markNews(marks, posts, ["p2"], "open")[1], { id: "p2", seen: "2026-10-15T08:30:00Z" });
  // Seeing an edited post ends its old status.
  assert.deepEqual(markNews([{ id: "p2", seen: "old", status: "deleted" }], posts, ["p2"]), [{ id: "p2", seen: "2026-10-15T08:30:00Z" }]);
  assert.deepEqual(markNews([], posts, ["gone"]), []);
});

test("pruneNews drops the markers of posts that left the feed", () => {
  const marks = [{ id: "p1", seen: "x" }, { id: "old", seen: "y", status: "deleted" }];
  assert.deepEqual(pruneNews(marks, posts), [{ id: "p1", seen: "x" }]);
});

test("news markers round-trip through the private file and merge per id", () => {
  const text = "<!-- note id=n1 status=open created=2026-10-15T08:00Z modified=2026-10-15T08:00Z -->\n## A\n\n"
    + "<!-- news id=p2 seen=2026-10-15T08:30:00Z status=archived -->\n\n<!-- news id=p1 seen=2026-10-14T10:00:00Z -->\n";
  const file = parseNotesFile(text);
  assert.deepEqual(file.news, [{ id: "p2", seen: "2026-10-15T08:30:00Z", status: "archived" }, { id: "p1", seen: "2026-10-14T10:00:00Z" }]);
  assert.equal(file.notes.length, 1);
  assert.equal(serializeNotesFile(file), text);
  const base = parseNotesFile("");
  const local = { ...base, news: [{ id: "p1", seen: "a" }] };
  const remote = { ...base, news: [{ id: "p2", seen: "b", status: "deleted" }] };
  assert.deepEqual(mergeNotesFiles(base, local, remote).file.news, [{ id: "p2", seen: "b", status: "deleted" }, { id: "p1", seen: "a" }]);
  // A marker pruned on one side stays pruned.
  assert.deepEqual(mergeNotesFiles(local, { ...base, news: [] }, local).file.news, []);
});
