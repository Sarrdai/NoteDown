// External content in a rendered note (backlog #30): embedded images and
// videos and links, handled by this device's setting for the note's circle
// (core/external.js). Media load by themselves, wait behind a tile that shows
// their address, or stay a placeholder; links open, ask first in a dialog
// with the real target, or are plain text.
import { externalPolicy, splitAddress } from "../core/external.js";
import { state } from "../store.js";
import { icon } from "./icons.js";
import { esc } from "./people.js";
import { showSnackbar } from "./snackbar.js";
import { pushEntry, leaveEntry } from "./dom.js";
import { SAMPLE_MEDIA } from "../sample.js";

const $ = id => document.getElementById(id);
const KIND = { image: "Image", video: "Video" };
// Addresses loaded with a tap stay loaded until the app restarts (their host knows them already).
const tapped = new Set();

/** The address with its host set apart, as HTML. */
export function addressHtml(href) {
  const a = splitAddress(href);
  return `${esc(a.before)}<strong>${esc(a.host)}</strong>${esc(a.after)}`;
}

/** Applies the policy of circle `key` ("" = private) to the media and links inside `root`. */
export function applyExternal(root, key) {
  const policy = externalPolicy(state.settings.external, key);
  root.querySelectorAll(".ext-media").forEach(el => fillMedia(el, policy.media));
  root.querySelectorAll("a[href]").forEach(a => {
    if (policy.links === "off") {
      const span = document.createElement("span");
      span.className = "link-off";
      span.append(...a.childNodes);
      a.replaceWith(span);
    } else {
      a.rel = "noopener noreferrer";
      if (policy.links === "confirm") a.dataset.confirm = "";
    }
  });
}

/** Fills a placeholder element (core/markdown.js) per `mode`: auto | click | never. */
export function fillMedia(el, mode) {
  const { kind, src, alt } = el.dataset;
  if (!src || mode === "never") return placeholder(el, `${KIND[kind]} embedded`);
  if (mode === "auto" || (mode === "click" && tapped.has(src))) return load(el);
  el.className = "ext-media ext-tile";
  el.setAttribute("role", "button");
  el.tabIndex = 0;
  el.setAttribute("aria-label", `Load ${KIND[kind].toLowerCase()} from ${splitAddress(src).host || src}`);
  el.innerHTML = `<span class="ext-icon">${icon(kind)}</span><span class="ext-text">`
    + `<span class="ext-title">${KIND[kind]}${alt ? " · " + esc(alt) : ""}</span>`
    + `<span class="ext-url">${addressHtml(src)}</span></span><span class="ext-load">Load</span>`;
}

function placeholder(el, text) {
  el.className = "ext-media ext-placeholder";
  el.removeAttribute("role");
  el.removeAttribute("tabindex");
  el.innerHTML = `${icon(el.dataset.kind)}<span>${esc(text)}</span>`;
}

function load(el) {
  const { kind, src, alt } = el.dataset;
  const media = document.createElement(kind === "video" ? "video" : "img");
  // Prototype: the sample's addresses look external but come from app/sample/media/.
  media.src = SAMPLE_MEDIA[src] || src;
  media.referrerPolicy = "no-referrer";
  if (kind === "video") { media.controls = true; media.preload = "metadata"; media.playsInline = true; }
  else { media.alt = alt; media.loading = "lazy"; }
  media.addEventListener("error", () => placeholder(el, `${KIND[kind]} couldn't be loaded`), { once: true });
  el.className = "ext-media ext-loaded";
  el.removeAttribute("role");
  el.removeAttribute("tabindex");
  el.removeAttribute("aria-label");
  el.replaceChildren(media);
}

// ---------- the link dialog ----------

let openHref = null;

function openLinkDialog(a) {
  openHref = a.href;
  const shown = a.textContent.trim();
  $("linkText").textContent = shown;
  $("linkText").hidden = !shown || shown === a.getAttribute("href");
  $("linkAddress").innerHTML = addressHtml(a.href);
  $("linkDialog").hidden = false;
  pushEntry({ link: true });
  $("linkCancel").focus({ preventScroll: true, focusVisible: false });
}

function closeLinkDialog({ fromHistory = false } = {}) {
  if (!openHref) return;
  openHref = null;
  $("linkDialog").hidden = true;
  if (!fromHistory) leaveEntry("link");
}

export function initExternal() {
  // A tap on a tile loads that one; on a link that asks first, the dialog opens.
  document.addEventListener("click", e => {
    const tile = e.target.closest(".ext-tile");
    if (tile) { e.preventDefault(); e.stopPropagation(); tapped.add(tile.dataset.src); return load(tile); }
    const a = e.target.closest("a[data-confirm]");
    if (a) { e.preventDefault(); e.stopPropagation(); openLinkDialog(a); }
  }, true);
  document.addEventListener("keydown", e => {
    const tile = e.target.closest?.(".ext-tile");
    if (tile && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); tapped.add(tile.dataset.src); load(tile); }
    if (e.key === "Escape" && openHref) { e.stopPropagation(); closeLinkDialog(); }
  }, true);
  $("linkOpen").addEventListener("click", () => {
    const href = openHref;
    closeLinkDialog();
    window.open(href, "_blank", "noopener,noreferrer");
  });
  $("linkCopy").addEventListener("click", async () => {
    const href = openHref;
    closeLinkDialog();
    try { await navigator.clipboard.writeText(href); showSnackbar("Address copied"); }
    catch { showSnackbar("Couldn't copy the address"); }
  });
  $("linkCancel").addEventListener("click", () => closeLinkDialog());
  $("linkDialog").addEventListener("click", e => { if (e.target === $("linkDialog")) closeLinkDialog(); });
  window.addEventListener("popstate", () => { if (openHref) closeLinkDialog({ fromHistory: true }); });
}
