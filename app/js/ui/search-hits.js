// Search hits: marks where the search text occurs in the rendered notes
// and contents entries (not in the edited note: its editor shows the plain
// text) and steps through the hits in the list with ▲ / ▼ (Enter /
// Shift+Enter in the field); the counter shows "current/total".
import { matchRanges } from "../core/query.js";
import { state } from "../store.js";

const BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, td, th";
const $ = id => document.getElementById(id);
const phone = window.matchMedia("(max-width: 599px)");

/** Wraps every hit of `search` under `root` in a <mark class="hit">. A hit
 *  may span formatting (several text nodes of one block): its marks share
 *  one `data-hit` number. */
export function markHits(root, search = state.search) {
  if (!search.trim()) return;
  const blocks = new Map();   // block element → its text nodes in order
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node; (node = walk.nextNode());) {
    if (node.parentElement.closest(".toc-more")) continue;
    const block = node.parentElement.closest(BLOCKS);
    const key = block && root.contains(block) ? block : root;
    blocks.has(key) ? blocks.get(key).push(node) : blocks.set(key, [node]);
  }
  let hit = 0;
  const pieces = [];   // [text node, start, end, hit number]
  for (const nodes of blocks.values()) {
    const ranges = matchRanges(nodes.map(n => n.data).join(""), search);
    let offset = 0;
    for (const node of nodes) {
      const end = offset + node.data.length;
      ranges.forEach(([s, e], i) => {
        if (s < end && e > offset) pieces.push([node, Math.max(s, offset) - offset, Math.min(e, end) - offset, hit + i]);
      });
      offset = end;
    }
    hit += ranges.length;
  }
  // From the end, so splitting a text node keeps the earlier offsets valid.
  for (const [node, s, e, n] of pieces.reverse()) {
    const part = node.splitText(s);
    part.splitText(e - s);
    const mark = Object.assign(document.createElement("mark"), { className: "hit" });
    mark.dataset.hit = n;
    part.replaceWith(mark);
    mark.append(part);
  }
}

let currentKey = null;   // "<note id>#<hit>" of the current hit
let lastSearch = "";

// The hits in the list in reading order, each with its marks.
function hitGroups() {
  const groups = [];
  for (const mark of $("list").querySelectorAll("mark.hit")) {
    const key = `${mark.closest(".note")?.dataset.id}#${mark.dataset.hit}`;
    if (groups.at(-1)?.key === key) groups.at(-1).marks.push(mark);
    else groups.push({ key, marks: [mark] });
  }
  return groups;
}

// Marks the current hit and updates the counter; `reveal` scrolls it into view.
function show(groups, index, reveal) {
  $("list").querySelectorAll("mark.hit.current").forEach(m => m.classList.remove("current"));
  const current = groups[index];
  currentKey = current?.key ?? null;
  current?.marks.forEach(m => m.classList.add("current"));
  $("hitCount").textContent = groups.length ? `${index + 1}/${groups.length}` : "0/0";
  $("hitPrev").disabled = $("hitNext").disabled = groups.length < 2;
  if (current && reveal) current.marks[0].scrollIntoView({ block: "center", behavior: phone.matches ? "auto" : "smooth" });
}

// After every change of the list: a new search starts at its first hit
// (scrolled to when it is out of view), otherwise the current hit stays.
function refresh() {
  const groups = hitGroups();
  if (state.search !== lastSearch) {
    lastSearch = state.search;
    show(groups, 0, false);
    const r = groups[0]?.marks[0].getBoundingClientRect();
    if (r && (r.top < $("topbar").getBoundingClientRect().bottom || r.bottom > window.innerHeight)) show(groups, 0, true);
    return;
  }
  const index = groups.findIndex(g => g.key === currentKey);
  show(groups, Math.max(0, index), false);
}

function step(delta) {
  const groups = hitGroups();
  if (!groups.length) return;
  const index = groups.findIndex(g => g.key === currentKey);
  show(groups, (Math.max(0, index) + delta + groups.length) % groups.length, true);
}

export function initSearchHits() {
  let frame = 0;
  new MutationObserver(() => {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; refresh(); });
  }).observe($("list"), { childList: true, subtree: true });
  $("hitPrev").addEventListener("click", () => step(-1));
  $("hitNext").addEventListener("click", () => step(1));
  // A mouse click keeps the field focused (Enter goes on stepping); a tap
  // lets the phone's keyboard go down, so the hit can be seen.
  for (const id of ["hitPrev", "hitNext"]) $(id).addEventListener("pointerdown", e => { if (e.pointerType === "mouse") e.preventDefault(); });
  $("searchInput").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
  });
}
