import { test } from "node:test";
import assert from "node:assert/strict";
import { reminderAt, reminderText, reminderSchedule } from "../app/js/core/reminders.js";

const note = (id, status, due, body = `## Note ${id}`) => ({ id, status, due, body });

test("reminderAt is the local time of day on that date", () => {
  const at = reminderAt("2026-10-14", "09:05");
  assert.deepEqual([at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes()], [2026, 9, 14, 9, 5]);
});

test("reminderText shows only the number by default, no note text (backlog #57)", () => {
  assert.deepEqual(reminderText([note("a", "open", "x")]), { title: "1 note due today", body: "Tap to open NoteDown." });
  const s = reminderSchedule([note("a", "open", "2026-10-20")], "09:00", new Date(2026, 9, 14, 8, 0));
  assert.ok(!JSON.stringify(s).includes("Note a"), "no title in the scheduled notification");
});

test("reminderText with titles counts the notes and lists their titles", () => {
  assert.deepEqual(reminderText([note("a", "open", "x")], "titles"), { title: "1 note due today", body: "Note a" });
  const t = reminderText([note("a", "open", "x"), note("b", "open", "x", "First line. Second.")], "titles");
  assert.equal(t.title, "2 notes due today");
  assert.equal(t.body, "Note a\nFirst line.");
});

test("reminderSchedule: one per due day, open notes only, future times only", () => {
  const notes = [
    note("a", "open", "2026-10-14"), note("b", "open", "2026-10-14"), note("c", "closed", "2026-10-14"),
    note("d", "open", "2026-10-13"), note("e", "open", null), note("f", "open", "2026-10-20"),
  ];
  const now = new Date(2026, 9, 14, 8, 0);
  const s = reminderSchedule(notes, "09:00", now);
  assert.deepEqual(s.map(r => [r.day, r.ids]), [["2026-10-14", ["a", "b"]], ["2026-10-20", ["f"]]]);
  assert.equal(s[0].title, "2 notes due today");
  // After the time of day, today's reminder has passed.
  assert.deepEqual(reminderSchedule(notes, "09:00", new Date(2026, 9, 14, 9, 30)).map(r => r.day), ["2026-10-20"]);
});
