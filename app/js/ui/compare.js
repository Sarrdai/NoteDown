// Comparing a private copy with its original (backlog #45): a dialog with the
// line diff (core/line-diff.js) — the lines only the copy has, the ones only
// the original has — and "Update copy", which overwrites the copy's text with
// the original's (Undo in the snackbar). Prototype: two layouts to choose from
// (settings.compareLayout): A "unified", one column; B "split", copy and
// original side by side from the tablet up (one column on the phone).
import { lineDiff, foldSame, sideBySide, diffCounts } from "../core/line-diff.js";
import { noteTitle } from "../core/markdown.js";
import { copyState } from "../core/note-links.js";
import { state, note, copyOriginal, updateCopy, circleOf } from "../store.js";
import { membersLabel, esc } from "./people.js";
import { relativeTime } from "./format.js";
import { showSnackbar } from "./snackbar.js";
import { pushEntry, leaveEntry, afterLeave } from "./dom.js";

const $ = id => document.getElementById(id);
const phone = window.matchMedia("(max-width: 599px)");
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
  const who = membersLabel(circleOf(o.id));
  $("compareHint").innerHTML = `“${esc(title)}” · shared with ${esc(who)} · edited ${esc(relativeTime(o.modified))}`
    + (st === "changed" ? ` · <strong>changed since your copy</strong>` : "");
  const same = del === 0 && add === 0;
  $("compareSummary").textContent = same ? "Your copy has the same text as the original."
    : `Update copy takes over the original's text: ${count(del, "line")} of your copy go, ${count(add, "line")} of the original come.`;
  const split = state.settings.compareLayout === "split" && !phone.matches;
  $("compareDialog").querySelector(".dialog").classList.toggle("split", split);
  const shown = unfolded ? ops : foldSame(ops, 2);
  $("compareDiff").innerHTML = same ? "" : split ? splitHtml(shown) : unifiedHtml(shown);
  $("compareDiff").hidden = same;
  $("compareUpdate").disabled = same && st !== "changed";
}

const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const SIGN = { del: "−", add: "+", same: "" };
const text = t => t.trim() ? esc(t) : "&nbsp;";
const foldHtml = n => `<button type="button" class="diff-fold">${count(n, "unchanged line")}</button>`;

// A: one column; the copy's own lines (red, −) above the original's (green, +).
function unifiedHtml(ops) {
  return `<div class="diff-legend"><span class="diff-key del">− only in your copy</span><span class="diff-key add">+ only in the original</span></div>`
    + `<div class="diff-lines">` + ops.map(o => o.type === "fold" ? foldHtml(o.count)
      : `<div class="diff-line ${o.type}"><span class="diff-sign" aria-hidden="true">${SIGN[o.type]}</span><span class="diff-text">${text(o.text)}</span></div>`).join("") + `</div>`;
}

// B: your copy left, the original right, a changed run's lines side by side.
function splitHtml(ops) {
  const cell = (side, at) => side ? `<div class="diff-cell ${at} ${side.type}">${text(side.text)}</div>` : `<div class="diff-cell ${at} blank"></div>`;
  return `<div class="diff-grid"><div class="diff-head">Your copy</div><div class="diff-head">Original</div>`
    + sideBySide(ops).map(r => r.fold ? `<div class="diff-span">${foldHtml(r.fold)}</div>` : cell(r.left, "left") + cell(r.right, "right")).join("") + `</div>`;
}

export function initCompare() {
  $("compareClose").addEventListener("click", () => close());
  $("compareDialog").addEventListener("click", e => {
    if (e.target === $("compareDialog")) return close();
    if (e.target.closest(".diff-fold")) { unfolded = true; fill(); }
  });
  $("compareOpen").addEventListener("click", () => {
    const id = copyOriginal(openId)?.id;
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
