// The privacy policy and the terms of use (`<web app>/privacy/`, `<web app>/terms/`; docs/requirements.md →
// "Legal texts"). The texts are the same for every copy of NoteDown; who runs it comes from app/config.json
// (`operator`: name, email and an optional postal address, written by the deploy workflows from repository
// variables, docs/operations.md), so no personal data sits in the repository. `?sample` shows placeholders.
const params = new URLSearchParams(location.search);
const FLAVORS = ["latte", "frappe", "macchiato", "mocha"];
const systemDark = matchMedia("(prefers-color-scheme: dark)");
const readStore = key => { try { return localStorage.getItem(key); } catch { return null; } };

function applyTheme() {
  let wanted = params.get("flavor");
  try { wanted ||= JSON.parse(readStore("notedown.settings") || "{}").flavor; } catch { /* default */ }
  document.documentElement.dataset.flavor = FLAVORS.includes(wanted) ? wanted : systemDark.matches ? "mocha" : "latte";
}

const SAMPLE = { name: "Name of the server's owner", email: "owner@example.com", address: "" };

async function config() {
  try { return await (await fetch(new URL("../config.json", import.meta.url), { cache: "no-store" })).json(); } catch { return {}; }
}

function fill(cfg) {
  const op = params.has("sample") ? SAMPLE : cfg.operator || {};
  const missing = !op.name || !op.email;
  const host = cfg.api ? new URL(cfg.api).host : "";
  for (const el of document.querySelectorAll("[data-op]")) {
    const key = el.dataset.op;
    if (key === "address") {
      el.hidden = !op.address;
      el.textContent = op.address || "";
    } else if (key === "email") {
      el.textContent = op.email || "";
      if (el.tagName === "A") el.href = op.email ? `mailto:${op.email}` : "";
    } else if (key === "host") {
      el.textContent = host || el.dataset.fallback || "";
    } else if (key === "web") {
      el.textContent = cfg.web || location.origin + new URL("../", import.meta.url).pathname.replace(/\/$/, "");
    } else {
      el.textContent = op[key] || "";
    }
  }
  for (const el of document.querySelectorAll("[data-op-missing]")) el.hidden = !missing;
  for (const el of document.querySelectorAll("[data-op-given]")) el.hidden = missing;
}

applyTheme();
systemDark.addEventListener("change", applyTheme);
config().then(fill);
