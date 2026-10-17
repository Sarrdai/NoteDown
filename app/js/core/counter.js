// Counters in a note's body (docs/requirements.md → "Counters"): a value
// followed by its steps in brackets, e.g. "12 [-4 -1 +1 +8]". The view shows
// the value; a tap pops up one button per step, which changes only the value
// in the source. Decimals are kept as written ("0,5" stays with a comma).
//
// Three kinds: a plain number; a time in hours and minutes ("23:30
// [-1:00 +0:15]", steps in h:mm too); hours as a decimal with the unit "h"
// ("23,5 h [-1 +0,25]"). A time or hours counter may carry a stopwatch "⏱",
// optionally with the minutes it rounds up to ("⏱15"); while it runs, its
// start (UTC, to the second) follows ("⏱15 2026-10-16T08:05:12Z").

const NUM = String.raw`-?\d+(?:[.,]\d+)?`;
const TIME = String.raw`-?\d+:[0-5]\d(?!\d)`;
const ITEM = String.raw`[+-]\d+(?::[0-5]\d|(?:[.,]\d+)?)(?![\d:])|⏱\d*|\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?Z`;
const BODY = String.raw`(${TIME}|${NUM})(?:[ \t]?(h))?[ \t]?\[[ \t]*((?:${ITEM})(?:[ \t]+(?:${ITEM}))*)[ \t]*\]`;
// Not glued to a word or another number: "a12 [+1]" and "1.12 [+1]" are no counters.
const BEFORE = String.raw`(?<![\p{L}\p{N}_.,:-])`;
const AT = new RegExp("^" + BODY, "u");
const ANY = new RegExp(BEFORE + BODY, "gu");
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?Z$/;

/**
 * The counter a regex match describes, or null when its parts don't fit
 * together: { raw, value, unit ("h" or ""), kind (number | time | hours),
 * steps, watch (null or { round (minutes, 0 = to the minute), since (start
 * or null) }) }.
 */
function parse(m) {
  const [raw, value, unit = "", inner] = m;
  const kind = value.includes(":") ? "time" : unit ? "hours" : "number";
  if (kind === "time" && unit) return null;
  const items = inner.trim().split(/[ \t]+/);
  const steps = [];
  let watch = null;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.startsWith("⏱")) {
      if (watch || kind === "number") return null;
      watch = { round: Number(it.slice(1) || 0), since: null };
      if (ISO.test(items[i + 1] || "")) watch.since = items[++i];
    } else if (ISO.test(it)) {
      return null;
    } else {
      if (it.includes(":") !== (kind === "time")) return null;
      steps.push(it);
    }
  }
  if (!steps.length && !watch) return null;
  return { raw, value, unit, kind, steps, watch };
}

/** The counter right at the start of `src`, or null (the Markdown renderer's tokenizer). */
export function counterAt(src) {
  const m = AT.exec(src);
  return m ? parse(m) : null;
}

/** Where the next counter in `src` starts, or -1. */
export function counterStart(src) {
  for (const m of src.matchAll(ANY)) if (parse(m)) return m.index;
  return -1;
}

/**
 * The counters of a body in document order, outside code: the parsed counter
 * (counterAt) with `from` / `to`, its offsets in the body.
 */
export function counters(body) {
  const out = [];
  let fence = null;
  let offset = 0;
  for (const line of body.split("\n")) {
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) fence = fence === null ? f[1] : fence === f[1] ? null : fence;
    else if (fence === null) {
      // Inline code spans hide what is in them, at the same offsets.
      const text = line.replace(/(`+)[^`]*?\1/g, s => " ".repeat(s.length));
      for (const m of text.matchAll(ANY)) {
        const c = parse(m);
        if (c) out.push({ ...c, from: offset + m.index, to: offset + m.index + m[0].length });
      }
    }
    offset += line.length + 1;
  }
  return out;
}

// ---------- arithmetic ----------

const minutes = s => {
  const m = /^([+-]?)(\d+):(\d\d)$/.exec(s);
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
};
const hhmm = (min, signed) => {
  const a = Math.abs(min);
  const t = `${Math.floor(a / 60)}:${String(a % 60).padStart(2, "0")}`;
  return min < 0 ? "-" + t : signed ? "+" + t : t;
};
const decimals = s => (/[.,](\d+)$/.exec(s) || ["", ""])[1].length;
const num = s => Number(s.replace(",", "."));

/** `value` plus `step`: h:mm with h:mm, else with as many decimals as the more precise of them and a comma if either has one. */
export function addStep(value, step) {
  if (value.includes(":")) return hhmm(minutes(value) + minutes(step), false);
  const d = Math.max(decimals(value), decimals(step));
  const sum = Math.round((num(value) + num(step)) * 10 ** d) / 10 ** d;
  const out = (Object.is(sum, -0) ? 0 : sum).toFixed(d);
  return /,/.test(value + step) ? out.replace(".", ",") : out;
}

/** Two steps added into one, with its sign ("+4" and "+4" → "+8", "+0" and "+0:15" → "+0:15"): the pop-up's pending change. */
export function sumSteps(a, b) {
  if (a.includes(":") || b.includes(":")) {
    const m = s => (s.includes(":") ? minutes(s) : num(s) * 60);
    return hhmm(m(a) + m(b), true);
  }
  const s = addStep(a, b);
  return s.startsWith("-") ? s : "+" + s;
}

/** Both sides' changes to a counter's value added up (`base` changed to `local` on one side, to `remote` on the other):
 *  the sync merge of a counter both sides stepped (core/text-merge.js). */
export function addChanges(base, local, remote) {
  const neg = v => (v.startsWith("-") ? v.slice(1) : "-" + v);
  return addStep(local, addStep(remote, neg(base)));
}

/** True when a pending change adds nothing. */
export const isZero = step => (step.includes(":") ? minutes(step) === 0 : num(step) === 0);

/** What the pop-up shows while its taps are pending: "36 + 8", "36 − 2", or just "36" without a change. */
export function pendingText(value, delta) {
  if (isZero(delta)) return value;
  return `${value} ${delta.startsWith("-") ? "−" : "+"} ${delta.slice(1)}`;
}

/**
 * A typed amount (the pop-up's input) as a step of the counter's kind, or
 * null: an optional sign (none adds), then for a time "h:mm" or plain
 * minutes ("40" → "+0:40"), else a number ("1,5" → "+1,5").
 */
export function parseAmount(text, kind) {
  const t = text.trim().replace(/^−/, "-");
  const sign = t.startsWith("-") ? "-" : "+";
  const rest = t.replace(/^[+-]\s*/, "");
  if (kind === "time") {
    if (/^\d+:[0-5]\d$/.test(rest)) return isZero(sign + rest) ? null : sign + rest;
    if (/^\d+$/.test(rest) && Number(rest) > 0) return sign + hhmm(Number(rest), false);
    return null;
  }
  if (!/^\d+(?:[.,]\d+)?$/.test(rest) || num(rest) === 0) return null;
  return sign + rest;
}

// ---------- the stopwatch ----------

/** A stopwatch's start as the note writes it (UTC to the second, "Z"). */
export const isoSecond = date => date.toISOString().slice(0, 19) + "Z";

/** Milliseconds a running stopwatch has run at `now` (0 when it isn't running). */
export function elapsedMs(watch, now) {
  return watch && watch.since ? Math.max(0, now - Date.parse(watch.since)) : 0;
}

/** "0:12:05": a running time as the chip shows it. */
export function clock(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * The step a stopwatch adds when it stops at `now`: the run in whole minutes,
 * rounded up to its rounding (at least one unit), as h:mm or as hours with
 * the value's separator and up to two decimals.
 */
export function watchStep(c, now) {
  const unit = c.watch.round || 1;
  const min = Math.max(1, Math.ceil(elapsedMs(c.watch, now) / 60000 / unit)) * unit;
  if (c.kind === "time") return hhmm(min, true);
  const h = String(Math.round(min / 60 * 100) / 100);
  return "+" + (c.value.includes(",") ? h.replace(".", ",") : h);
}

// ---------- changes in the source ----------

function rebuild(c, value, since) {
  const items = [...c.steps];
  if (c.watch) items.push("⏱" + (c.watch.round || ""), ...(since ? [since] : []));
  const head = c.raw.slice(c.value.length, c.raw.indexOf("["));   // the unit and spaces as written
  return `${value}${head}[${items.join(" ")}]`;
}

/**
 * The body with the n-th counter (0-based, document order) changed: `step`
 * added to its value, then its stopwatch started, stopped or its run
 * discarded (`watch`: "start" | "stop" | "discard", at `now`; stopping adds
 * the run, discarding drops it).
 */
export function changeCounter(body, index, { step = null, watch = null, now = Date.now() } = {}) {
  const c = counters(body)[index];
  if (!c) return body;
  let value = step && !isZero(step) ? addStep(c.value, step) : c.value;
  let since = c.watch && c.watch.since;
  if (watch === "start" && c.watch && !since) since = isoSecond(new Date(now));
  if (watch === "stop" && since) value = addStep(value, watchStep(c, now));
  if (watch === "stop" || watch === "discard") since = null;
  // Only the value changes while the brackets stay as written.
  if (since === (c.watch && c.watch.since)) {
    const at = c.raw.indexOf(c.value);
    return body.slice(0, c.from + at) + value + body.slice(c.from + at + c.value.length);
  }
  return body.slice(0, c.from) + rebuild(c, value, since) + body.slice(c.to);
}

/**
 * The running stopwatches of a body: [{ index (of the counter), since,
 * label (the text before the counter on its line, without list marker and
 * a trailing colon; "" when there is none) }].
 */
export function runningWatches(body) {
  return counters(body).flatMap((c, index) => {
    if (!c.watch || !c.watch.since) return [];
    const label = body.slice(body.lastIndexOf("\n", c.from - 1) + 1, c.from)
      .replace(/^\s*(?:#{1,6}\s+|(?:[-*+]|\d+[.)])\s+(?:\[[ xX/-]\]\s+)?)/, "")
      .replace(/[*_`~]/g, "").replace(/[\s:–-]+$/, "").trim();
    return [{ index, since: c.watch.since, label }];
  });
}

/** The body with the n-th counter changed by `step` (the pop-up's sum). */
export function stepCounter(body, index, step) {
  return changeCounter(body, index, { step });
}

/** A line with a new counter at its end (the toolbar's counter button; `time` the time counter with a stopwatch); a line that has one stays as it is. */
export function appendCounter(line, time = false) {
  if (counters(line).length) return line;
  const text = line.replace(/\s+$/, "");
  return (/\S/.test(text) ? text + " " : text) + (time ? "0:00 [-0:15 +0:15 ⏱15]" : "0 [-1 +1]");
}

/** The counter's markup, shared by the rendered note and the editor's live preview. */
export function counterHtml(c) {
  const attrs = [`data-steps="${c.steps.join(" ")}"`, `data-kind="${c.kind}"`];
  if (c.watch) attrs.push(`data-watch="${c.watch.round}"`);
  if (c.watch && c.watch.since) attrs.push(`data-since="${c.watch.since}"`);
  const label = c.value + (c.unit ? " " + c.unit : "");
  const watch = c.watch ? `<span class="counter-watch" aria-hidden="true"></span>` : "";
  return `<button type="button" class="counter${c.watch && c.watch.since ? " running" : ""}" ${attrs.join(" ")} aria-label="Counter ${label}">`
    + `<span class="counter-value">${label}</span>${watch}</button>`;
}
