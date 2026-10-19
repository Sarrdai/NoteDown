// One snackbar at a time: a message with an optional action (Undo unless named), gone after 5 s.
let timer = null;
let undoFn = null;

export function showSnackbar(text, undo, actionLabel = "Undo") {
  const bar = document.getElementById("snackbar");
  document.getElementById("snackText").textContent = text;
  const btn = document.getElementById("snackUndo");
  undoFn = undo || null;
  btn.hidden = !undoFn;
  btn.textContent = actionLabel;
  btn.onclick = () => { const fn = undoFn; hideSnackbar(); if (fn) fn(); };
  bar.hidden = false;
  clearTimeout(timer);
  timer = setTimeout(hideSnackbar, 5000);
}

export function hideSnackbar() {
  clearTimeout(timer);
  undoFn = null;
  document.getElementById("snackbar").hidden = true;
}
