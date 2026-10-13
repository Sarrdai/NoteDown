// Small DOM helpers shared by the sync panel and the share dialog.

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
