// A popup menu anchored to a button. Items: { label, checked?, onSelect }
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
    b.innerHTML = (item.checked !== undefined ? icon("check", "icon check") : "") + `<span></span>`;
    b.lastChild.textContent = item.label;
    b.addEventListener("click", e => { e.stopPropagation(); closeMenu(); item.onSelect(); });
    return b;
  }));
  menu.hidden = false;
  openFor = anchor;
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  menu.style.top = Math.min(r.bottom + 6, window.innerHeight - menu.offsetHeight - 8) + "px";
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
}
