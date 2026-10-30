// Speech input with a live transcript and the microphone's input level.
// Uses the browser's Web Speech API (Chrome, Edge, Safari; needs https or
// localhost); in the Android app, whose web view has none, Android's
// speech recognizer through the native Dictation plugin
// (mobile/android/.../DictationPlugin.java), on the device or online as
// Settings → Privacy → Speech recognition says. With ?dictation=demo the
// prototype replays app/sample/dictation.md instead, so the flow can be
// tried and tested without a microphone (on a local address only).
import { Capacitor, registerPlugin } from "../../vendor/capacitor-core.esm.js";
import { prototypeSwitches } from "../platform.js";
import { state } from "../store.js";

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const NativeDictation = Capacitor.isNativePlatform() ? registerPlugin("Dictation") : null;
const demo = prototypeSwitches && new URLSearchParams(location.search).get("dictation") === "demo";

export function dictationAvailable() {
  return demo || Boolean(NativeDictation) || Boolean(SpeechRecognition && window.isSecureContext);
}

/**
 * Starts listening. Callbacks: onInterim(text) — the not yet final tail,
 * onFinal(text) — a finished segment, onLevel(0..1), onError(code).
 * Returns { stop(): Promise (resolves after the last final segment), cancel() }.
 */
export function startDictation(cb) {
  return demo ? demoSession(cb) : NativeDictation ? nativeSession(cb) : speechSession(cb);
}

// One native session ends after a pause, like the browser's; it is
// restarted until stopped. Errors are Web Speech error codes.
function nativeSession({ onInterim, onFinal, onLevel, onError }) {
  let active = true, cancelled = false, resolveStop = null;
  const start = () => NativeDictation.start({ lang: lang(), onDevice: state.settings.dictation !== "online" })
    .catch(err => fail(err.code || "start-failed"));
  const fail = code => { if (!active) return; active = false; onError(code); };
  const listeners = [
    NativeDictation.addListener("partial", e => { if (!cancelled) onInterim(e.text); }),
    NativeDictation.addListener("final", e => { if (!cancelled && e.text) onFinal(e.text); }),
    NativeDictation.addListener("level", e => { if (active) onLevel(e.value); }),
    NativeDictation.addListener("error", e => { if (e.code !== "no-speech" && e.code !== "aborted") fail(e.code); }),
    NativeDictation.addListener("end", () => { if (active) { onLevel(0); start(); } else close(); }),
  ];
  const close = () => {
    listeners.forEach(l => l.then(h => h.remove()));
    if (resolveStop) resolveStop();
  };
  start();

  return {
    stop() {
      active = false;
      return new Promise(resolve => {
        resolveStop = resolve;
        NativeDictation.stop();
        setTimeout(resolve, 1500); // the recognizer may never answer
      });
    },
    cancel() { active = false; cancelled = true; NativeDictation.cancel(); close(); },
  };
}

const lang = () => navigator.language || "en-US";

/** Asks Android to download the on-device speech pack of the device language (Android 13 and later;
 *  rejects with code "unsupported" before). */
export function downloadSpeechPack() {
  return NativeDictation ? NativeDictation.downloadLanguage({ lang: lang() }) : Promise.reject({ code: "unsupported" });
}

function speechSession({ onInterim, onFinal, onLevel, onError }) {
  const rec = new SpeechRecognition();
  rec.lang = navigator.language || "en-US";
  rec.continuous = true;
  rec.interimResults = true;
  let active = true;
  let resolveStop = null;
  const meter = levelMeter(onLevel);

  rec.onresult = e => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) onFinal(r[0].transcript);
      else interim += r[0].transcript;
    }
    onInterim(interim);
    meter.pulse();
  };
  rec.onerror = e => { if (e.error !== "no-speech" && e.error !== "aborted") onError(e.error); };
  // Browsers end a session after a pause; keep listening until stopped.
  rec.onend = () => {
    if (active) { try { rec.start(); } catch { /* already restarting */ } return; }
    meter.close();
    if (resolveStop) resolveStop();
  };
  try { rec.start(); } catch (err) { onError(err.name || "start-failed"); }

  return {
    stop() {
      active = false;
      return new Promise(resolve => {
        resolveStop = resolve;
        rec.stop();
        setTimeout(resolve, 1500); // some engines never send "end"
      });
    },
    cancel() { active = false; rec.onresult = null; rec.abort(); meter.close(); },
  };
}

// Input level from the microphone; falls back to a pulse on each result
// when the browser doesn't allow a second capture next to recognition.
function levelMeter(onLevel) {
  let ctx = null, stream = null, raf = 0, fallback = 0, closed = false;
  const fallbackLoop = () => {
    fallback *= 0.9;
    onLevel(fallback);
    raf = requestAnimationFrame(fallbackLoop);
  };
  navigator.mediaDevices?.getUserMedia({ audio: true }).then(s => {
    if (closed) { s.getTracks().forEach(t => t.stop()); return; }
    stream = s;
    ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(s).connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    const loop = () => {
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += v * v;
      onLevel(Math.min(1, Math.sqrt(sum / data.length) * 5));
      raf = requestAnimationFrame(loop);
    };
    loop();
  }).catch(() => { if (!closed) fallbackLoop(); });
  return {
    pulse() { fallback = 0.6 + Math.random() * 0.4; },
    close() {
      closed = true;
      cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach(t => t.stop());
      if (ctx) ctx.close();
    },
  };
}

function demoSession({ onInterim, onFinal, onLevel }) {
  let words = [], i = 0, interim = [], timer = 0, raf = 0, t = 0;
  fetch(new URL("../../sample/dictation.md", import.meta.url)).then(r => r.text()).then(text => {
    words = text.replace(/^#.*$/gm, "").split(/\s+/).filter(Boolean);
    timer = setInterval(() => {
      if (i >= words.length) return;
      interim.push(words[i++]);
      if (/[.!?]$/.test(interim[interim.length - 1])) { onFinal(interim.join(" ")); interim = []; onInterim(""); }
      else onInterim(interim.join(" "));
    }, 170);
  });
  const loop = () => {
    t += 0.12;
    onLevel(i < words.length ? 0.35 + 0.3 * Math.sin(t) * Math.sin(t * 2.7) + 0.25 * Math.random() : 0.03);
    raf = requestAnimationFrame(loop);
  };
  loop();
  const end = () => { clearInterval(timer); cancelAnimationFrame(raf); };
  return {
    stop() { end(); if (interim.length) onFinal(interim.join(" ")); onInterim(""); return Promise.resolve(); },
    cancel() { end(); },
  };
}
