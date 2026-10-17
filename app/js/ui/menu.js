// A popup menu anchored to a button. Items: { label, icon?, checked?, disabled?, onSelect }
// or { section: "Title" } or { separator: true }. Picking an item closes it.
import { icon } from "./icons.js";

let openFor = null;

export function openMenu(anchor, items) {
  const menu = document.getElementById("menu");
  if (openFor === anchor) return closeMenu();
  menu.replaceChildren(...items.map(item => {
    if (item.section) return Object.assign(document.createElement("div"), { className: "menu-section", textContent: item.section });
    if (item.separator) return Object.assign(document.createElement("div"), { className: "menu-sep" });
    const b = document.createElement("button");
    b.className = "menu-item";
    b.setAttribute("role", item.checked === undefined ? "menuitem" : "menuitemradio");
    if (item.checked !== undefined) b.setAttribute("aria-checked", String(item.checked));
    // `lead`: trusted HTML before the label, e.g. a circle's avatars.
    b.innerHTML = (item.checked !== undefined ? icon("check", "icon check") : item.icon ? icon(item.icon) : item.lead ? `<span class="menu-lead">${item.lead}</span>` : "") + `<span></span>`;
    b.lastChild.textContent = item.label;
    b.disabled = !!item.disabled;
    // No focus change: a menu opened from the editor toolbar keeps the keyboard up.
    b.addEventListener("pointerdown", e => e.preventDefault());
    b.addEventListener("click", e => { e.stopPropagation(); closeMenu(); item.onSelect(); });
    return b;
  }));
  menu.hidden = false;
  openFor = anchor;
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  // Below the anchor, or above it when it sits at the bottom (the toolbar).
  const below = r.bottom + 6 + h <= window.innerHeight - 8;
  menu.style.top = (below ? r.bottom + 6 : Math.max(8, r.top - 6 - h)) + "px";
  menu.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + "px";
}

export function closeMenu() {
  document.getElementById("menu").hidden = true;
  openFor = null;
}

export function initMenu() {
  document.addEventListener("click", e => {
    if (openFor && !e.target.closest("#menu") && !openFor.contains(e.target)) closeMenu();
  });
  window.addEventListener("resize", closeMenu);
  // A scroll that moves the anchor away leaves the menu behind: close it.
  document.addEventListener("scroll", e => { if (openFor && e.target.contains?.(openFor)) closeMenu(); }, true);
}

/** A choice in place of a <select> (whose native picker looks foreign on Android): a button with
 *  the chosen label that opens the app's menu. options: [[value, label], …]. */
export function pickButton(value, options, onChange, { cls = "", label } = {}) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = ("pick " + cls).trim();
  b.setAttribute("aria-haspopup", "menu");
  if (label) b.setAttribute("aria-label", label);
  b.innerHTML = `<span class="pick-label"></span>` + icon("down", "icon pick-chevron");
  const set = v => { value = v; b.firstChild.textContent = options.find(([o]) => o === v)?.[1] ?? ""; };
  set(value);
  b.addEventListener("click", () => openMenu(b, options.map(([v, l]) => ({
    label: l, checked: v === value, onSelect: () => { if (v !== value) { set(v); onChange(v); } },
  }))));
  return b;
}
