// Speech input with a live transcript and the microphone's input level.
// Uses the browser's Web Speech API (Chrome, Edge, Safari; needs https or
// localhost). With ?dictation=demo the prototype replays
// app/sample/dictation.md instead, so the flow can be tried and tested
// without a microphone.

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const demo = new URLSearchParams(location.search).get("dictation") === "demo";

export function dictationAvailable() {
  return demo || Boolean(SpeechRecognition && window.isSecureContext);
}

/**
 * Starts listening. Callbacks: onInterim(text) — the not yet final tail,
 * onFinal(text) — a finished segment, onLevel(0..1), onError(code).
 * Returns { stop(): Promise (resolves after the last final segment), cancel() }.
 */
export function startDictation(cb) {
  return demo ? demoSession(cb) : speechSession(cb);
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
