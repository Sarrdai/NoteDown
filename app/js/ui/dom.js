// Small DOM helpers shared by the sync panel and the share dialog, and the
// history entries of the layers the back key closes.

/** h("button", { class: "btn", onclick }, "Label", ...children) */
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...kids.flat().filter(k => k != null && k !== false));
  return el;
}

export const text = (s, cls = "sheet-text") => h("p", { class: cls }, s);
export const button = (label, cls, onclick) => h("button", { class: "btn " + cls, type: "button", onclick }, label);

// ---------- history entries (the Android back key) ----------
// Each layer the back key closes (editing, the contents sheet, the
// selection, dialogs) sits on its own history entry. Leaving one from the
// app goes back asynchronously: entries pushed meanwhile wait for it, and
// its popstate doesn't reach the layers' own back handlers (this listener is
// added at module load, before theirs).
let leaving = 0;
const queue = [];
history.scrollRestoration = "manual";   // going back must not scroll the list
window.addEventListener("popstate", e => {
  if (!leaving) return;
  leaving--;
  e.stopImmediatePropagation();
  if (!leaving) queue.splice(0).forEach(fn => fn());
});

/** Adds a history entry for a layer that just opened. */
export function pushEntry(entry) {
  afterLeave(() => history.pushState(entry, ""));
}

/** Leaves the current entry when it is the layer's (`key` set in its state). */
export function leaveEntry(key) {
  if (!history.state?.[key]) return;
  leaving++;
  history.back();
}

/** Runs `fn` once the entries being left are gone (right away when none are). */
export function afterLeave(fn) {
  if (leaving) queue.push(fn);
  else fn();
}
