// Counters in a note's body (docs/requirements.md → "Counters"): a number
// followed by its steps in brackets, e.g. "12 [-4 -1 +1 +8]". The view shows
// the number with one button per step; a tap changes only the number in the
// source. Decimals are kept as written ("0,5" stays with a comma).

const NUM = String.raw`-?\d+(?:[.,]\d+)?`;
const STEP = String.raw`[+-]\d+(?:[.,]\d+)?`;
const BODY = String.raw`(${NUM})[ \t]?\[[ \t]*(${STEP}(?:[ \t]+${STEP})*)[ \t]*\]`;
// Not glued to a word or another number: "a12 [+1]" and "1.12 [+1]" are no counters.
const BEFORE = String.raw`(?<![\p{L}\p{N}_.,-])`;

/** A counter right at the start of `src`, or null (the Markdown renderer's tokenizer). */
export const COUNTER_AT = new RegExp("^" + BODY, "u");
/** Where the next counter in `src` starts, or -1. */
export function counterStart(src) {
  const m = new RegExp(BEFORE + BODY, "u").exec(src);
  return m ? m.index : -1;
}

/** The steps of a counter's bracket ("-4 -1 +1 +8") as strings. */
export function parseSteps(text) {
  return text.trim().split(/[ \t]+/);
}

/** `value` plus `step`, with as many decimals as the more precise of them and a comma if either has one. */
export function addStep(value, step) {
  const decimals = s => (/[.,](\d+)$/.exec(s) || ["", ""])[1].length;
  const d = Math.max(decimals(value), decimals(step));
  const num = s => Number(s.replace(",", "."));
  const sum = Math.round((num(value) + num(step)) * 10 ** d) / 10 ** d;
  const out = (Object.is(sum, -0) ? 0 : sum).toFixed(d);
  return /,/.test(value + step) ? out.replace(".", ",") : out;
}

/**
 * The counters of a body in document order, outside code: [{ from, to (the
 * number's offsets in the body), value, steps }].
 */
export function counters(body) {
  const out = [];
  const re = new RegExp(BEFORE + BODY, "gu");
  let fence = null;
  let offset = 0;
  for (const line of body.split("\n")) {
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) fence = fence === null ? f[1] : fence === f[1] ? null : fence;
    else if (fence === null) {
      // Inline code spans hide what is in them, at the same offsets.
      const text = line.replace(/(`+)[^`]*?\1/g, s => " ".repeat(s.length));
      for (const m of text.matchAll(re)) {
        out.push({ from: offset + m.index, to: offset + m.index + m[1].length, value: m[1], steps: parseSteps(m[2]) });
      }
    }
    offset += line.length + 1;
  }
  return out;
}

/** The body with the n-th counter (0-based, document order) changed by `step`. */
export function stepCounter(body, index, step) {
  const c = counters(body)[index];
  if (!c) return body;
  return body.slice(0, c.from) + addStep(c.value, step) + body.slice(c.to);
}

/** A line with a new counter at its end (the toolbar's counter button); a line that has one stays as it is. */
export function appendCounter(line) {
  if (counters(line).length) return line;
  const text = line.replace(/\s+$/, "");
  return (/\S/.test(text) ? text + " " : text) + "0 [-1 +1]";
}

/** The counter's markup, shared by the rendered note and the editor's live preview. */
export function counterHtml(value, steps, disabled = false) {
  const off = disabled ? " disabled" : "";
  const button = s => `<button type="button" class="counter-step${s.startsWith("-") ? " minus" : ""}" data-step="${s}"${off} aria-label="${s.startsWith("-") ? "Minus" : "Plus"} ${s.slice(1)}">${s.startsWith("-") ? "−" + s.slice(1) : s}</button>`;
  return `<span class="counter" data-steps="${steps.join(" ")}"><button type="button" class="counter-value"${off} aria-label="Counter ${value}">${value}</button>${steps.map(button).join("")}</span>`;
}
