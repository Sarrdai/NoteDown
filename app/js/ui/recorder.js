// The + button: a tap creates a note, a long-press dictates one, operated
// like Signal's voice messages — hold to record, release to save, slide
// left to cancel, slide up to lock for hands-free recording (then tap the
// button to finish or the bin to cancel).
import { dictationAvailable, startDictation } from "./dictation.js";
import { showSnackbar } from "./snackbar.js";
import { icon } from "./icons.js";

const HOLD_MS = 350;
const CANCEL_DX = -110;
const LOCK_DY = -90;
const BARS = 36;

const $ = id => document.getElementById(id);

export function initRecorder({ onTap, canHold = () => true, onTranscript }) {
  const fab = $("fab");
  const app = $("app");
  let press = null;      // { x, y, timer } while the finger is down
  let rec = null;        // { session, finals, interim, started, locked }
  let levels = [];
  let smooth = 0;        // the FAB's pulse, smoothed against the jittery raw level
  let lastBar = 0;
  let clock = 0;

  const bars = $("recLevel");
  bars.replaceChildren(...Array.from({ length: BARS }, () => document.createElement("span")));
  $("recTrash").innerHTML = icon("trash");
  $("recLockIcon").innerHTML = icon("lock") + icon("chevronUp", "icon chevron");

  const setFab = name => { fab.querySelector(".fab-new").innerHTML = icon(name); };
  const vibrate = ms => { try { navigator.vibrate?.(ms); } catch { /* not allowed */ } };

  function begin() {
    press.timer = null;
    if (!dictationAvailable()) {
      showSnackbar(window.isSecureContext ? "Dictation isn't available in this browser" : "Dictation needs https or localhost");
      press = null;
      return;
    }
    vibrate(15);
    rec = { finals: [], interim: "", started: Date.now(), locked: false };
    levels = [];
    smooth = 0;
    rec.session = startDictation({
      onInterim: t => { if (rec) { rec.interim = t; preview(); } },
      onFinal: t => { if (rec) { rec.finals.push(t.trim()); rec.interim = ""; preview(); } },
      onLevel: level,
      // After cancel(), so its "Dictation cancelled" doesn't hide the reason.
      onError: code => { cancel(); showSnackbar(code === "not-allowed" ? "Microphone access was denied" : "Dictation stopped: " + code); },
    });
    app.classList.add("recording");
    $("recorder").hidden = false;
    setFab("mic");
    preview();
    clock = setInterval(tick, 250);
    tick();
  }

  function level(v) {
    // Fast attack, slow release, like a VU meter.
    smooth += (v - smooth) * (v > smooth ? 0.4 : 0.1);
    fab.style.setProperty("--level", smooth.toFixed(3));
    const now = performance.now();
    if (now - lastBar < 70) return;
    lastBar = now;
    levels.push(v);
    if (levels.length > BARS) levels.shift();
    const spans = bars.children;
    for (let i = 0; i < BARS; i++) {
      const l = levels[i - (BARS - levels.length)] ?? 0;
      spans[i].style.transform = `scaleY(${Math.max(0.08, l).toFixed(3)})`;
    }
  }

  function tick() {
    const s = Math.floor((Date.now() - rec.started) / 1000);
    $("recTime").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  function preview() {
    const text = [...rec.finals, rec.interim].filter(Boolean).join(" ");
    const el = $("recPreview");
    el.textContent = text || "Listening…";
    el.classList.toggle("placeholder", !text);
  }

  function lock() {
    rec.locked = true;
    app.classList.add("rec-locked");
    setFab("send");
    vibrate(10);
  }

  function reset() {
    clearInterval(clock);
    app.classList.remove("recording", "rec-locked");
    $("recorder").hidden = true;
    $("recHint").style.transform = "";
    fab.style.removeProperty("--level");
    setFab("plus");
    rec = null;
  }

  function cancel() {
    if (!rec) return;
    rec.session.cancel();
    reset();
    vibrate(10);
    showSnackbar("Dictation cancelled");
  }

  async function finish() {
    if (!rec) return;
    const r = rec;
    await r.session.stop();
    const text = [...r.finals, r.interim].filter(Boolean).join(" ").trim();
    reset();
    if (text) onTranscript(text);
    else showSnackbar("Nothing was recognized");
  }

  fab.addEventListener("contextmenu", e => e.preventDefault());
  fab.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    // No focus on the button: the new note's editor must keep it (and the keyboard).
    e.preventDefault();
    if (rec && rec.locked) { press = { x: e.clientX, y: e.clientY, timer: null, finishing: true }; return; }
    fab.setPointerCapture(e.pointerId);
    // Where the button doesn't dictate (the archive's bin), a press is just a tap.
    press = { x: e.clientX, y: e.clientY, timer: canHold() ? setTimeout(begin, HOLD_MS) : null, tap: !canHold() };
  });
  fab.addEventListener("pointermove", e => {
    if (!press || !rec || rec.locked) return;
    const dx = Math.min(0, e.clientX - press.x);
    const dy = Math.min(0, e.clientY - press.y);
    $("recHint").style.transform = `translateX(${dx * 0.6}px)`;
    $("recLock").style.setProperty("--pull", Math.min(1, dy / LOCK_DY).toFixed(2));
    if (dx < CANCEL_DX) { press = null; cancel(); }
    else if (dy < LOCK_DY) lock();
  });
  fab.addEventListener("pointerup", () => {
    if (!press) return;
    const p = press;
    press = null;
    if (p.finishing) return finish();
    if (p.timer || p.tap) { clearTimeout(p.timer); onTap(); return; }
    if (rec && !rec.locked) finish();
  });
  fab.addEventListener("pointercancel", () => {
    if (press && press.timer) clearTimeout(press.timer);
    press = null;
    if (rec && !rec.locked) cancel();
  });
  // A touch tap's click comes after the new note's editor has hidden the
  // button and would land on the note beneath it, ending the edit at once.
  fab.addEventListener("touchend", e => { if (e.cancelable) e.preventDefault(); }, { passive: false });
  // Keyboard activation (Enter / Space) creates a note like a tap.
  fab.addEventListener("click", e => { if (e.detail === 0 && !rec) onTap(); });
  $("recTrash").addEventListener("click", cancel);
}
