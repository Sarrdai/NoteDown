// TEMPORARY (backlog #20 transition; remove once the owner's identity from before post-quantum wrapping is
// upgraded): the page the card "Enter your recovery key once" opens (ui/sync-notice.js). Only the recovery key can
// give the recovery device its ML-KEM key; then every file key is renewed and wrapped hybrid for it too.
import { state } from "../store.js";
import { normalizeRecoveryKey } from "../core/sharing.js";
import { finishRecoveryKem } from "../sync/client.js";
import { registerPage, openPanel, action, closePanel } from "./sync-panel.js";
import { showSnackbar } from "./snackbar.js";
import { h, text, button } from "./dom.js";

registerPage("recoveryKem", {
  title: "Post-quantum protection",
  render: () => {
    const input = h("input", {
      type: "text", class: "input mono", autocomplete: "off", autocapitalize: "characters", spellcheck: "false",
      placeholder: "ABCD-EFGH-…", "aria-label": "Recovery key", "data-autofocus": true,
    });
    const { btn, error } = action("Finish protection", async () => {
      const key = normalizeRecoveryKey(input.value);
      if (!key) { input.focus(); throw new Error("That doesn't look like a recovery key. It has 26 letters and digits."); }
      if (state.sync.simulated) throw new Error("The sample has no real recovery key.");
      await finishRecoveryKem(key);
      closePanel();
      showSnackbar("Post-quantum protection finished");
    });
    input.addEventListener("keydown", e => { if (e.key === "Enter") btn.click(); });
    return [
      text("Your notes are now protected against future quantum computers — except the copies of your keys kept for your recovery key, which only the recovery key itself can renew. Enter it once; nothing else changes."),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Recovery key"), input),
      h("div", { class: "sheet-actions" }, btn, button("Later", "", closePanel)),
      error,
    ];
  },
});

/** Opens the page (the card's button). */
export const openRecoveryKem = () => openPanel("recoveryKem");
