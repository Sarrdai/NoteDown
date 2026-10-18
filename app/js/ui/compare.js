// Comparing a private copy with its original (backlog #45): a dialog with the
// line diff (core/line-diff.js) — the lines only the copy has, the ones only
// the original has — and "Update copy", which overwrites the copy's text with
// the original's (Undo in the snackbar). One column in every tier (decided
// 2026-10-18 over copy and original side by side: the same on every device).
import { lineDiff, foldSame, diffCounts } from "../core/line-diff.js";
import { noteTitle } from "../core/markdown.js";
import { copyState } from "../core/note-links.js";
import { note, copyOriginal, updateCopy, circleOf } from "../store.js";
import { membersLabel, esc } from "./people.js";
import { relativeTime } from "./format.js";
import { showSnackbar } from "./snackbar.js";
import { pushEntry, leaveEntry, afterLeave } from "./dom.js";
import { refOf } from "../core/note-ref.js";

const $ = id => document.getElementById(id);
let openId = null;
let unfolded = false;

/** Opens the comparison of copy `id` with its original. */
export function openCompare(id) {
  const c = note(id), o = copyOriginal(id);
  if (!c || !o) return;
  openId = id;
  unfolded = false;
  fill();
  $("compareDialog").hidden = false;
  pushEntry({ compare: true });
  $("compareClose").focus({ preventScroll: true, focusVisible: false });
}

function close({ fromHistory = false } = {}) {
  if (!openId) return;
  openId = null;
  $("compareDialog").hidden = true;
  if (!fromHistory) leaveEntry("compare");
}

function fill() {
  const c = note(openId), o = copyOriginal(openId);
  const st = copyState(c, o);
  const ops = lineDiff(c.body, o.body);
  const { del, add } = diffCounts(ops);
  const title = noteTitle(o.body).text || "Untitled";
  $("compareTitle").textContent = "Compare with original";
  const who = membersLabel(circleOf(refOf(o)));
  $("compareHint").innerHTML = `“${esc(title)}” · shared with ${esc(who)} · edited ${esc(relativeTime(o.modified))}`
    + (st === "changed" ? ` · <strong>changed since your copy</strong>` : "");
  const same = del === 0 && add === 0;
  $("compareSummary").textContent = same ? "Your copy has the same text as the original."
    : `Update copy takes over the original's text: ${count(del, "line")} of your copy go, ${count(add, "line")} of the original come.`;
  const shown = unfolded ? ops : foldSame(ops, 2);
  $("compareDiff").innerHTML = same ? "" : diffHtml(shown);
  $("compareDiff").hidden = same;
  $("compareUpdate").disabled = same && st !== "changed";
}

const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const SIGN = { del: "−", add: "+", same: "" };
const text = t => t.trim() ? esc(t) : "&nbsp;";
const foldHtml = n => `<button type="button" class="diff-fold">${count(n, "unchanged line")}</button>`;

// One column; the copy's own lines (red, −) above the original's (green, +).
function diffHtml(ops) {
  return `<div class="diff-legend"><span class="diff-key del">− only in your copy</span><span class="diff-key add">+ only in the original</span></div>`
    + `<div class="diff-lines">` + ops.map(o => o.type === "fold" ? foldHtml(o.count)
      : `<div class="diff-line ${o.type}"><span class="diff-sign" aria-hidden="true">${SIGN[o.type]}</span><span class="diff-text">${text(o.text)}</span></div>`).join("") + `</div>`;
}

export function initCompare() {
  $("compareClose").addEventListener("click", () => close());
  $("compareDialog").addEventListener("click", e => {
    if (e.target === $("compareDialog")) return close();
    if (e.target.closest(".diff-fold")) { unfolded = true; fill(); }
  });
  $("compareOpen").addEventListener("click", () => {
    const original = copyOriginal(openId), id = original && refOf(original);
    close();
    if (id) afterLeave(() => document.dispatchEvent(new CustomEvent("notedown:show-note", { detail: { id } })));
  });
  $("compareUpdate").addEventListener("click", () => {
    const id = openId;
    close();
    afterLeave(() => showSnackbar("Copy updated", updateCopy(id)));
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && openId) { e.stopPropagation(); close(); } }, true);
  window.addEventListener("popstate", () => { if (openId) close({ fromHistory: true }); });
}
