// Unit tests for the Due view's logic (app/js/core/due-list.js). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { dueItems, dueGroups, dueNowCount, titleOfNotes } from "../app/js/core/due-list.js";

const TODAY = "2026-10-18";
const note = (id, extra = {}, body = `## Note ${id}`) => ({ id, status: "open", due: null, body, ...extra });

test("dueItems: a note's own date and each open task's date are separate items", () => {
  const n = note("a", { due: "2026-10-20" }, "## A\n- [ ] one 📅 2026-10-19\n- [ ] no date\n- [/] two 📅 2026-10-21");
  assert.deepEqual(dueItems([n], TODAY), [
    { kind: "note", id: "a", day: "2026-10-20" },
    { kind: "task", id: "a", index: 0, day: "2026-10-19", text: "one" },
    { kind: "task", id: "a", index: 2, day: "2026-10-21", text: "two" },
  ]);
});

test("dueItems: done and cancelled tasks are left out", () => {
  const n = note("a", {}, "## A\n- [x] d 📅 2026-10-19\n- [-] c 📅 2026-10-19\n- [ ] o 📅 2026-10-19");
  assert.deepEqual(dueItems([n], TODAY).map(i => i.index), [2]);
});

test("dueItems: closed and deleted notes are left out, permanent ones stay", () => {
  const t = "## X\n- [ ] t 📅 2026-10-19";
  const items = dueItems([
    note("c", { status: "closed", due: "2026-10-19" }, t), note("d", { deleted: "2026-10-01", due: "2026-10-19" }, t),
    note("p", { status: "permanent", due: "2026-10-19" }, t),
  ], TODAY);
  assert.deepEqual(items.map(i => `${i.kind}:${i.id}`), ["note:p", "task:p"]);
});

test("dueItems uses the note's address", () => {
  const n = note("a", { due: "2026-10-19" });
  Object.defineProperty(n, "ref", { value: "a@k" });
  assert.equal(dueItems([n], TODAY)[0].id, "a@k");
});

test("dueGroups: boundaries and order of the groups, empty ones left out", () => {
  const it = day => ({ kind: "note", id: day, day });
  const g = dueGroups(["2026-10-17", "2026-10-18", "2026-10-19", "2026-10-25", "2026-10-26"].map(it), TODAY);
  assert.deepEqual(g.map(x => [x.key, x.title, x.items.map(i => i.day)]), [
    ["overdue", "Overdue", ["2026-10-17"]], ["today", "Today", ["2026-10-18"]],
    ["soon", "Next 7 days", ["2026-10-19", "2026-10-25"]], ["later", "Later", ["2026-10-26"]],
  ]);
  assert.deepEqual(dueGroups([it("2026-10-18")], TODAY).map(x => x.key), ["today"]);
  assert.deepEqual(dueGroups([], TODAY), []);
});

test("dueGroups: month and year boundaries of the next 7 days", () => {
  const it = day => ({ kind: "note", id: day, day });
  const g = dueGroups(["2026-12-31", "2027-01-02", "2027-01-03"].map(it), "2026-12-26");
  assert.deepEqual(g.map(x => [x.key, x.items.length]), [["soon", 2], ["later", 1]]);
});

test("dueGroups: by day, notes before tasks, then note title, then task index", () => {
  const notes = [note("a", {}, "## Zeta"), note("b", {}, "## Alpha")];
  const d = "2026-10-19";
  const items = [
    { kind: "task", id: "a", index: 1, day: d, text: "" }, { kind: "task", id: "b", index: 3, day: d, text: "" },
    { kind: "task", id: "b", index: 0, day: d, text: "" }, { kind: "note", id: "a", day: d },
    { kind: "note", id: "b", day: d }, { kind: "task", id: "a", index: 0, day: "2026-10-20", text: "" },
    { kind: "note", id: "a", day: "2026-10-18" },
  ];
  const [today, soon] = dueGroups(items, TODAY, titleOfNotes(notes));
  assert.equal(today.key, "today");
  assert.deepEqual(soon.items.map(i => `${i.kind}:${i.id}:${i.index ?? ""}:${i.day.slice(8)}`), [
    "note:b::19", "note:a::19", "task:b:0:19", "task:b:3:19", "task:a:1:19", "task:a:0:20",
  ]);
});

test("dueNowCount counts overdue and today only", () => {
  const it = day => ({ kind: "note", id: day, day });
  assert.equal(dueNowCount(["2026-10-01", "2026-10-18", "2026-10-19"].map(it), TODAY), 2);
  assert.equal(dueNowCount([], TODAY), 0);
});
