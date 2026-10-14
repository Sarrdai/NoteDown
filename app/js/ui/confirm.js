// A confirmation dialog for permanent deletion (docs/interaction-concept.md →
// "Feedback and undo"): a title, a line of text, an optional checkbox with a
// warning, Cancel and a red action button. It sits on its own history entry,
// so the back button / gesture cancels it.
const $ = id => document.getElementById(id);
let current = null; // { onConfirm, check } while open

/**
 * Opens the dialog. `check` = { label, warning } adds an unchecked checkbox;
 * `okLabel(checked)` → the button's label, or null to disable it.
 * `onConfirm(checked)` runs once the dialog is closed and its history entry gone.
 */
export function openConfirm({ title, text, check = null, okLabel, onConfirm }) {
  current = { onConfirm, okLabel };
  $("confirmTitle").textContent = title;
  $("confirmText").textContent = text;
  $("confirmCheckRow").hidden = !check;
  $("confirmCheck").checked = false;
  if (check) {
    $("confirmCheckLabel").textContent = check.label;
    $("confirmWarning").textContent = check.warning;
  }
  refresh();
  $("confirmDialog").hidden = false;
  history.pushState({ confirm: true }, "");
  $("confirmCancel").focus({ preventScroll: true, focusVisible: false });
}

export const isConfirmOpen = () => !!current;

function refresh() {
  const checked = $("confirmCheck").checked;
  const label = current.okLabel(checked);
  $("confirmOk").textContent = label || current.okLabel(true);
  $("confirmOk").disabled = !label;
  $("confirmWarning").hidden = !checked;
}

function close({ fromHistory = false } = {}) {
  if (!current) return;
  current = null;
  $("confirmDialog").hidden = true;
  if (!fromHistory && history.state && history.state.confirm) history.back();
}

// Runs `fn` once the dialog's history entry is gone (or right away when there was none).
function afterBack(fn) {
  if (!(history.state && history.state.confirm)) return fn();
  let done = false;
  const run = () => { if (!done) { done = true; fn(); } };
  window.addEventListener("popstate", run, { once: true });
  setTimeout(run, 300);
}

export function initConfirm() {
  $("confirmCancel").addEventListener("click", () => close());
  $("confirmDialog").addEventListener("click", e => { if (e.target === $("confirmDialog")) close(); });
  $("confirmCheck").addEventListener("change", refresh);
  $("confirmOk").addEventListener("click", () => {
    const { onConfirm } = current, checked = $("confirmCheck").checked;
    afterBack(() => onConfirm(checked));
    close();
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && current) { e.stopPropagation(); close(); } }, true);
  window.addEventListener("popstate", () => { if (current) close({ fromHistory: true }); });
}
