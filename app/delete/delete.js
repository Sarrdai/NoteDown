// Deleting your sync data with the recovery key (`<web app>/delete/`, no link from the app;
// docs/requirements.md → "Deleting your sync data"): the recovery key gives the identity key, which signs
// the deletion (sync/delete-identity.js). Works without a device of the identity — also in a browser that
// never synced. The server is the app's: ?api=, then the one this browser remembers, then app/config.json.
// `?sample` takes any well-formed key and deletes nothing.
import { createApi } from "../js/sync/api.js";
import { deleteWithRecoveryKey } from "../js/sync/delete-identity.js";
import { normalizeRecoveryKey } from "../js/core/sharing.js";
import { serverUrl } from "../js/core/linking.js";
import { readStored } from "../js/vault.js";

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const FLAVORS = ["latte", "frappe", "macchiato", "mocha"];
const systemDark = matchMedia("(prefers-color-scheme: dark)");
const readStore = key => { try { return localStorage.getItem(key); } catch { return null; } };

// The theme of the app's settings, read from the encrypted vault (app/js/vault.js) once it is open.
let storedFlavor = "";
readStored("notedown.settings").then(text => {
  try { storedFlavor = JSON.parse(text || "{}").flavor || ""; } catch { /* default */ }
  applyTheme();
});

function applyTheme() {
  let wanted = params.get("flavor") || storedFlavor;
  document.documentElement.dataset.flavor = FLAVORS.includes(wanted) ? wanted : systemDark.matches ? "mocha" : "latte";
}

async function server() {
  let config = {};
  try { config = await (await fetch(new URL("../config.json", import.meta.url), { cache: "no-store" })).json(); } catch { /* none */ }
  const raw = params.get("api") || readStore("notedown.api") || config.api;
  return raw ? serverUrl(new URL(raw, location.href).href) : "";
}

function show(step) {
  for (const id of ["formStep", "noServer", "doneStep"]) $(id).hidden = id !== step;
}

async function start() {
  applyTheme();
  systemDark.addEventListener("change", applyTheme);
  const sample = params.has("sample");
  const url = sample ? "" : await server();
  if (!sample && !url) return show("noServer");
  $("host").textContent = sample ? "sample server" : new URL(url).host;
  const api = sample ? null : createApi(url, () => null);
  $("form").addEventListener("submit", async e => {
    e.preventDefault();
    const error = $("error"), submit = $("submit");
    error.hidden = true;
    if (!normalizeRecoveryKey($("key").value)) {
      error.textContent = "That doesn't look like a recovery key. It has 26 letters and digits.";
      error.hidden = false;
      $("key").focus();
      return;
    }
    submit.disabled = true;
    submit.textContent = "Deleting…";
    try {
      if (!sample) await deleteWithRecoveryKey(api, $("key").value);
      show("doneStep");
    } catch (err) {
      error.textContent = err.message || "Something went wrong.";
      error.hidden = false;
      submit.disabled = false;
      submit.textContent = "Delete for good";
    }
  });
  document.body.dataset.ready = "1";
}

start();
