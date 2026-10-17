#!/usr/bin/env node
// Draws the note motifs into app/decor/*.svg (docs/requirements.md → "Note
// colors and motifs"), so they share one illustration style: fine lines of one
// weight with round ends, a soft wash of the shapes offset down-left beneath
// them, small sparkles and dots as accents, and a fade from the top right
// corner toward the text. The app uses the files as masks and paints them in
// the note's tone (app.css), so only shape and opacity count. Run by hand after
// changing a motif:  node scripts/make-decor.js
"use strict";
const fs = require("fs"), path = require("path");
const OUT = process.argv[2] || path.join(__dirname, "..", "app", "decor");
const f = n => +n.toFixed(1);
const P = (...a) => a.map(v => typeof v === "number" ? f(v) : v).join(" ");

// ---- helpers ----
function leaf(bx, by, deg, L, W) {
  const a = deg * Math.PI / 180, dx = Math.cos(a), dy = Math.sin(a), px = -dy, py = dx;
  const tx = bx + dx * L, ty = by + dy * L, mx = bx + dx * L * .45, my = by + dy * L * .45;
  const d = P("M", bx, by, "Q", mx + px * W, my + py * W, tx, ty, "Q", mx - px * W, my - py * W, bx, by, "Z");
  const vein = P("M", bx + dx * L * .12, by + dy * L * .12, "L", bx + dx * L * .78, by + dy * L * .78);
  return { d, vein };
}
const spark = (cx, cy, r) => { const k = r * .16; return P("M", cx, cy - r, "Q", cx + k, cy - k, cx + r, cy, "Q", cx + k, cy + k, cx, cy + r, "Q", cx - k, cy + k, cx - r, cy, "Q", cx - k, cy - k, cx, cy - r, "Z"); };
const dot = (cx, cy, r) => P("M", cx - r, cy, "a", r, r, 0, 1, 0, 2 * r, 0, "a", r, r, 0, 1, 0, -2 * r, 0, "Z");
const circle = dot;
const rrect = (x, y, w, h, r) => P("M", x + r, y, "H", x + w - r, "a", r, r, 0, 0, 1, r, r, "V", y + h - r, "a", r, r, 0, 0, 1, -r, r, "H", x + r, "a", r, r, 0, 0, 1, -r, -r, "V", y + r, "a", r, r, 0, 0, 1, r, -r, "Z");
const bez = (p0, p1, p2, p3, t) => { const u = 1 - t; return [0, 1].map(i => u*u*u*p0[i] + 3*u*u*t*p1[i] + 3*u*t*t*p2[i] + t*t*t*p3[i]); };
const bezT = (p0, p1, p2, p3, t) => { const u = 1 - t; return [0, 1].map(i => 3*u*u*(p1[i]-p0[i]) + 6*u*t*(p2[i]-p1[i]) + 3*t*t*(p3[i]-p2[i])); };
const snow = (cx, cy, r) => { let s = ""; for (let i = 0; i < 3; i++) { const a = i * Math.PI / 3 + Math.PI / 2; s += P("M", cx - Math.cos(a) * r, cy - Math.sin(a) * r, "L", cx + Math.cos(a) * r, cy + Math.sin(a) * r, ""); } return s; };

// One file: wash (offset soft fill), lines (monoline strokes), solid (small filled accents).
// The whole drawing fades from the corner toward the text.
function svg(name, desc, { wash = [], lines = [], solid = [], thin = [], defs = "", washAttr = "", lineAttr = "" }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160"><!-- NoteDown motif "${name}": ${desc} Used as a mask, so only shape and opacity count: a soft offset wash, fine lines on top, all fading from the corner toward the text. -->` +
    `<defs><radialGradient id="f" cx="1" cy="0" r="1.3"><stop offset=".4" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity=".2"/></radialGradient><mask id="m"><rect width="160" height="160" fill="url(#f)"/></mask>${defs}</defs>` +
    `<g mask="url(#m)">` +
    (wash.length ? `<path d="${wash.join("")}" fill-opacity=".2" transform="translate(-3 3)"${washAttr}/>` : "") +
    (lines.length ? `<path d="${lines.join("")}" fill="none" stroke="#000" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"${lineAttr}/>` : "") +
    (thin.length ? `<path d="${thin.join("")}" fill="none" stroke="#000" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" opacity=".7"/>` : "") +
    (solid.length ? `<path d="${solid.join("")}"/>` : "") +
    `</g></svg>\n`;
}
const M = {};

// ---- Leaves: a sprig hanging from the corner, leaves shrinking toward the tip, a few berries ----
{
  const p0 = [156, 4], p1 = [128, 28], p2 = [112, 70], p3 = [70, 138];
  const wash = [], lines = [P("M", ...p0, "C", ...p1, ...p2, ...p3)], solid = [], thin = [];
  const n = 7;
  for (let i = 0; i < n; i++) {
    const t = .1 + i * .12, [x, y] = bez(p0, p1, p2, p3, t), [tx, ty] = bezT(p0, p1, p2, p3, t);
    const ang = Math.atan2(ty, tx) * 180 / Math.PI, side = i % 2 ? 1 : -1;
    const L = 30 - i * 2.2, W = 10.5 - i * .7;
    const l = leaf(x, y, ang + side * 52, L, W);
    wash.push(l.d); lines.push(l.d); thin.push(l.vein);
  }
  const [ex, ey] = bezT(p0, p1, p2, p3, 1), tip = leaf(...p3, Math.atan2(ey, ex) * 180 / Math.PI, 18, 6.5);
  wash.push(tip.d); lines.push(tip.d); thin.push(tip.vein);
  // berry twig
  const [bx, by] = bez(p0, p1, p2, p3, .3);
  lines.push(P("M", bx, by, "Q", bx + 10, by + 8, bx + 12, by + 20));
  for (const [x, y, r] of [[bx + 12, by + 24, 4.2], [bx + 19, by + 20, 3.4], [bx + 6, by + 20, 3]]) { wash.push(circle(x, y, r)); lines.push(circle(x, y, r)); }
  solid.push(dot(54, 52, 1.6), dot(150, 112, 1.8), spark(44, 96, 4));
  M.leaves = svg("Leaves", "a sprig hanging from the card's top right corner.", { wash, lines, solid, thin });
}

// ---- Stars: a crescent moon, sparkles and specks ----
{
  const c1 = [122, 42], r1 = 21, c2 = [131, 34], r2 = 18;
  // intersections of the two circles
  const dx = c2[0] - c1[0], dy = c2[1] - c1[1], d = Math.hypot(dx, dy);
  const a = (r1*r1 - r2*r2 + d*d) / (2*d), h = Math.sqrt(r1*r1 - a*a);
  const mx = c1[0] + a*dx/d, my = c1[1] + a*dy/d;
  const A = [mx + h*dy/d, my - h*dx/d], B = [mx - h*dy/d, my + h*dx/d];
  const moon = P("M", ...A, "A", r1, r1, 0, 1, 0, ...B, "A", r2, r2, 0, 0, 1, ...A, "Z");
  M.stars = svg("Stars", "a crescent moon with sparkles in the card's top right corner.", {
    wash: [moon], lines: [moon],
    thin: [P("M", 62, 70, "L", 84, 58, "L", 100, 76)],
    solid: [spark(66, 28, 11), spark(148, 92, 8), spark(100, 76, 5.5), spark(84, 58, 3.5), spark(62, 70, 3), dot(44, 46, 1.6), dot(150, 14, 1.4), dot(126, 120, 1.6), dot(90, 18, 1.2), dot(76, 104, 1.3)],
  });
}

// ---- Birthday: a two-tier cake with candles, a balloon, confetti ----
{
  const scal = (x0, x1, y, n) => { const w = (x1 - x0) / n; let s = P("M", x0, y); for (let i = 0; i < n; i++) s += P("q", w / 2, i % 2 ? 5 : 8, w, 0); return s; };
  const t1 = rrect(68, 98, 72, 32, 5), t2 = rrect(80, 72, 48, 26, 5);
  const candles = [94, 104, 114].map(x => rrect(x - 2.2, 58, 4.4, 14, 1.6));
  const flames = [94, 104, 114].map(x => P("M", x, 44, "C", x + 4.6, 50, x + 3.4, 55, x, 55, "C", x - 3.4, 55, x - 4.6, 50, x, 44, "Z"));
  const bal = P("M", 140, 12, "C", 149, 12, 152, 20, 152, 26, "C", 152, 35, 145, 42, 140, 43, "C", 135, 42, 128, 35, 128, 26, "C", 128, 20, 131, 12, 140, 12, "Z");
  M.birthday = svg("Birthday", "a cake with candles and a balloon in the card's top right corner.", {
    wash: [t1, t2, bal], lines: [t1, t2, ...candles, bal, P("M", 56, 130, "H", 152), P("M", 137, 46, "h6", "l-3 -3z")],
    thin: [scal(68, 140, 106, 8), scal(80, 128, 80, 6), P("M", 140, 46, "c", -6, 8, 6, 14, -4, 24), P("M", 134, 20, "q", 2, -4, 6, -4)],
    solid: [...flames, spark(60, 36, 6), dot(48, 78, 1.8), dot(150, 70, 1.6), P("M", 62, 62, "l4 -1.5 1.5 4 -4 1.5z"), P("M", 154, 112, "l3.5 -2.5 2.5 3.5 -3.5 2.5z"), dot(72, 48, 1.3)],
  });
}

// ---- Christmas: baubles of different lengths hanging from the top edge, snowflakes ----
{
  const lines = [], thin = [], wash = [], solid = [];
  const baubles = [[80, 20, 11], [112, 44, 15], [144, 26, 10]];
  baubles.forEach(([x, len, r], i) => {
    const cy = len + 5 + r;
    thin.push(P("M", x, -2, "V", len));
    const cap = rrect(x - 4, len, 8, 5, 1.2), ball = circle(x, cy, r);
    lines.push(cap, ball); wash.push(ball);
    if (i === 1) thin.push(P("M", x - r * .96, cy - 3, "Q", x, cy + 4, x + r * .96, cy - 3), P("M", x - r * .9, cy + 5, "Q", x, cy + 12, x + r * .9, cy + 5));
    else thin.push(P("M", x - r * .5, cy - r * .35, "A", r * .55, r * .55, 0, 0, 1, x - r * .1, cy - r * .62));
    if (i === 0) solid.push(dot(x - 3, cy + 3, 1.3), dot(x + 3.5, cy + 1, 1.3), dot(x, cy + 6, 1.1));
  });
  // a small bow tied on the middle string
  const bx = 112, by = 18;
  const loop = s => P("M", bx, by, "C", bx + s * 8, by - 8, bx + s * 13, by - 2, bx + s * 11, by + 3, "C", bx + s * 9, by + 7, bx + s * 4, by + 3, bx, by, "Z");
  wash.push(loop(1), loop(-1)); lines.push(loop(1), loop(-1));
  thin.push(P("M", bx, by, "l", -5, 10, "M", bx, by, "l", 5, 10));
  thin.push(snow(56, 50, 7), snow(150, 92, 6), snow(92, 96, 4.5));
  solid.push(spark(132, 120, 4.5), dot(48, 82, 1.6), dot(124, 140, 1.4), dot(66, 22, 1.4), dot(152, 62, 1.2));
  M.christmas = svg("Christmas", "baubles hanging from the card's top edge in its top right corner.", { wash, lines, thin, solid });
}

// ---- Gifts: a tied box with a bow, a small box beside it ----
{
  const body = rrect(80, 76, 58, 50, 3), lid = rrect(74, 62, 70, 16, 3);
  const bx = 109, by = 62;
  const loopL = P("M", bx, by, "C", bx - 16, by - 2, bx - 24, by - 16, bx - 17, by - 22, "C", bx - 10, by - 28, bx - 2, by - 14, bx, by, "Z");
  const loopR = P("M", bx, by, "C", bx + 16, by - 2, bx + 24, by - 16, bx + 17, by - 22, "C", bx + 10, by - 28, bx + 2, by - 14, bx, by, "Z");
  const sBody = rrect(46, 104, 30, 24, 2.5), sLid = rrect(43, 96, 36, 9, 2.5);
  M.gifts = svg("Gifts", "a gift box with a bow and a small box in the card's top right corner.", {
    wash: [body, lid, loopL, loopR, sBody, sLid],
    lines: [body, lid, loopL, loopR, P("M", 104, 62, "V", 126, "M", 114, 62, "V", 126), sBody, sLid, P("M", 61, 96, "V", 128), P("M", 40, 128, "H", 152)],
    thin: [P("M", bx, by, "c", -4, 6, -10, 10, -15, 11, "M", bx, by, "c", 4, 6, 10, 10, 15, 11), P("M", 61, 96, "c", -4, -6, -10, -6, -10, -2, "c", 0, 4, 6, 3, 10, 2, "c", 4, -6, 10, -6, 10, -2, "c", 0, 4, -6, 3, -10, 2)],
    solid: [spark(148, 34, 7), spark(62, 54, 5), dot(78, 30, 1.6), dot(154, 66, 1.4), dot(40, 80, 1.4)],
  });
}

// ---- Travel: a plane on a dashed route from a map pin, small clouds ----
{
  const plane = "M0 -32C3 -32 4.5 -28 4.5 -24V-9L31 6V12L4.5 4V19L13 26V31L0 27.5L-13 31V26L-4.5 19V4L-31 12V6L-4.5 -9V-24C-4.5 -28 -3 -32 0 -32Z";
  const pin = (x, y) => P("M", x, y + 11, "C", x - 6, y + 4, x - 8.5, y - 1, x - 8.5, y - 4, "A", 8.5, 8.5, 0, 1, 1, x + 8.5, y - 4, "C", x + 8.5, y - 1, x + 6, y + 4, x, y + 11, "Z");
  const cloud = (x, y, s) => P("M", x, y, "H", x + 30 * s, "a", 6.5 * s, 6.5 * s, 0, 0, 0, -2 * s, -12.5 * s, "a", 10 * s, 10 * s, 0, 0, 0, -18.5 * s, -2.5 * s, "a", 7 * s, 7 * s, 0, 0, 0, -9.5 * s, 15 * s, "Z");
  M.travel = svg("Travel", "a plane on a dashed route in the card's top right corner.", {
    wash: [pin(50, 116), cloud(60, 42, 1), cloud(132, 100, .75)],
    lines: [pin(50, 116), cloud(60, 42, 1), cloud(132, 100, .75)],
    thin: [P("M", 52, 106, "C", 60, 80, 92, 92, 104, 72, "S", 108, 58, 114, 52)],
    solid: [dot(50, 112, 2.6), spark(152, 70, 4.5), dot(40, 64, 1.4), dot(150, 128, 1.3)],
  }).replace(/<g mask="url\(#m\)">/, `<g mask="url(#m)"><g transform="translate(128 32) rotate(45) scale(.78)"><path d="${plane}" fill-opacity=".2" transform="translate(-3.8 -0.6)"/><path d="${plane}" fill="none" stroke="#000" stroke-width="2.8" stroke-linejoin="round"/><path d="M0 -24V12" fill="none" stroke="#000" stroke-width="1.8" stroke-linecap="round" opacity=".5"/></g>`)
    .replace(/(<path d="M52 106[^"]*" fill="none" stroke="#000" stroke-width="1.4")/, '$1 stroke-dasharray="3.5 5"');
}

// ---- Packing: a suitcase with straps, a tag and stickers ----
{
  const body = rrect(70, 54, 72, 72, 11);
  const handle = P("M", 94, 54, "V", 45, "a", 6, 6, 0, 0, 1, 6, -6, "h", 12, "a", 6, 6, 0, 0, 1, 6, 6, "V", 54);
  const tag = P("M", 64, 62, "L", 74, 66, "a", 3, 3, 0, 0, 1, 1.6, 3.8, "L", 70, 84, "a", 3, 3, 0, 0, 1, -3.8, 1.6, "L", 53, 80, "a", 3, 3, 0, 0, 1, -1.6, -3.8, "L", 56, 66, "Z");
  M.packing = svg("Packing", "a suitcase with a luggage tag in the card's top right corner.", {
    wash: [body, tag],
    lines: [body, handle, P("M", 88, 54, "V", 126, "M", 124, 54, "V", 126), circle(84, 132, 4), circle(128, 132, 4), tag],
    thin: [P("M", 94, 49, "C", 84, 48, 72, 54, 68, 64), P("M", 56, 74, "l", 10, 4, "M", 55, 78.5, "l", 7, 2.8), circle(106, 84, 8), P("M", 98, 104, "h", 16, "M", 100, 109, "h", 12)],
    solid: [spark(106, 84, 4.5), dot(67.5, 67, 1.6), spark(150, 28, 6), dot(62, 40, 1.5), dot(154, 96, 1.4), dot(50, 108, 1.3)],
  });
}

// ---- Camper: a camper bus with a surfboard, driving into the corner ----
{
  const body = P("M", 44, 52, "H", 118, "C", 138, 52, 150, 62, 152, 80, "V", 104, "a", 5, 5, 0, 0, 1, -5, 5, "H", 43, "a", 5, 5, 0, 0, 1, -5, -5, "V", 58, "a", 6, 6, 0, 0, 1, 6, -6, "Z");
  const wins = [rrect(46, 60, 18, 15, 3), rrect(70, 60, 18, 15, 3), rrect(94, 60, 18, 15, 3), P("M", 121, 60, "H", 133, "C", 140, 61, 145, 66, 147, 75, "H", 121, "Z")];
  const board = P("M", 48, 44, "C", 62, 35, 130, 35, 144, 41, "C", 130, 47, 62, 49, 48, 44, "Z");
  const wheel = (x) => [circle(x, 109, 11), circle(x, 109, 3.8)];
  const defs = `<mask id="w"><rect width="160" height="160" fill="#fff"/><circle cx="68" cy="109" r="14.5"/><circle cx="128" cy="109" r="14.5"/></mask>`;
  let s = svg("Camper", "a camper bus with a surfboard in the card's top right corner.", {
    defs,
    wash: [body, board, ...wheel(68).slice(0, 1), ...wheel(128).slice(0, 1)],
    lines: [body, ...wins, board, ...wheel(68), ...wheel(128)],
    thin: [P("M", 38, 84, "H", 152), P("M", 116, 60, "V", 105), P("M", 62, 48, "v", -4, "M", 128, 48, "v", -4), P("M", 30, 124, "H", 158), P("M", 16, 72, "h", 14, "M", 10, 86, "h", 20, "M", 20, 100, "h", 10)],
    solid: [circle(147, 92, 3), spark(40, 28, 5), dot(152, 22, 1.5)],
  });
  // wheel wells are cut out of the body (wash and outline) so the wheels sit cleanly in them
  s = s.replace(/<path d="([^"]*)" fill-opacity=".2" transform="translate\(-3 3\)"\/>/, (m, d) => {
    const parts = d.split("Z").filter(Boolean).map(x => x + "Z");
    return `<g mask="url(#w)" fill-opacity=".2" transform="translate(-3 3)"><path d="${parts[0]}${parts[1]}"/></g><path d="${parts.slice(2).join("")}" fill-opacity=".2" transform="translate(-3 3)"/>`;
  });
  s = s.replace(/(<path d=")([^"]*)(" fill="none" stroke="#000" stroke-width="2.2"[^>]*\/>)/, (m, a, d, c) => {
    const parts = d.split("Z").filter(Boolean).map(x => x + "Z");
    const attrs = c.slice(1, -2);
    return `<path d="${parts[0]}"${attrs} mask="url(#w)"/><path d="${parts.slice(1).join("")}"${attrs}/>`;
  });
  M.camper = s;
}

// ---- Shopping: a tote with a baguette, greens and a bottle ----
{
  const bag = P("M", 68, 72, "H", 140, "L", 134, 134, "a", 4, 4, 0, 0, 1, -4, 3.6, "H", 78, "a", 4, 4, 0, 0, 1, -4, -3.6, "Z");
  const handle = P("M", 88, 72, "C", 88, 52, 120, 52, 120, 72);
  // items stick out over the bag's top edge; clipped so the bag hides their lower part
  const bread = "M-6 -30a6 6 0 0 1 12 0V30H-6Z";
  const bottle = P("M", 124, 76, "V", 48, "c", 0, -5, 4, -7, 4, -11, "V", 28, "h", 6, "v", 9, "c", 0, 4, 4, 6, 4, 11, "V", 76, "Z");
  const l1 = leaf(80, 76, -112, 34, 9), l2 = leaf(84, 76, -140, 28, 8), l3 = leaf(80, 76, -84, 26, 7);
  const defs = `<clipPath id="c"><rect width="160" height="72"/></clipPath>`;
  let s = svg("Shopping", "a shopping tote with bread, greens and a bottle in the card's top right corner.", {
    defs,
    wash: [bag],
    lines: [bag, P("M", 69.2, 82, "H", 138.8)],
    thin: [P("M", 98, 106, "l", 6, -6, "l", 6, 6, "l", -6, 8, "z")],
    solid: [spark(152, 28, 6), spark(58, 46, 4), dot(150, 100, 1.5), dot(54, 112, 1.4)],
  });
  const items = `<g clip-path="url(#c)"><path d="${l1.d}${l2.d}${l3.d}${bottle}" fill-opacity=".2" transform="translate(-3 3)"/><g transform="translate(106 50) rotate(16)"><path d="${bread}" fill-opacity=".2" transform="translate(-3 3)"/><path d="${bread}M-6 -18l12 -5M-6 -6l12 -5M-6 6l12 -5" fill="none" stroke="#000" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></g><path d="${l1.d}${l2.d}${l3.d}${bottle}" fill="none" stroke="#000" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="${l1.vein}${l2.vein}${l3.vein}M124 54h12" fill="none" stroke="#000" stroke-width="1.4" stroke-linecap="round" opacity=".7"/></g>`;
  s = s.replace('<g mask="url(#m)">', '<g mask="url(#m)">' + items + `<path d="${handle}" fill="none" stroke="#000" stroke-width="2.2" stroke-linecap="round"/>`);
  M.shopping = s;
}

// ---- Waves: three layered swells along the bottom, tiling every 240 units ----
{
  const W = 240, H = 44;
  const wave = (y, amp, period, phase) => { let d = ""; const n = 64; for (let i = -2; i <= n + 2; i++) { const x = i * W / n; d += P(i === -2 ? "M" : "L", x, y + amp * Math.sin((x / period) * 2 * Math.PI + phase)); } return d; };
  const area = (y, amp, period, phase) => wave(y, amp, period, phase) + P("V", H + 2, "H", -8, "Z");
  M.waves = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"><!-- NoteDown motif "Waves": three layered swells along the card's bottom, repeated across (tiles every ${W} units). Used as a mask, so only shape and opacity count. -->` +
    `<path d="${area(14, 3, 240, 0)}" fill-opacity=".1"/><path d="${area(24, 3.5, 120, 1.2)}" fill-opacity=".14"/><path d="${area(34, 3, 80, 2.4)}" fill-opacity=".22"/>` +
    `<path d="${wave(14, 3, 240, 0)}${wave(24, 3.5, 120, 1.2)}${wave(34, 3, 80, 2.4)}" fill="none" stroke="#000" stroke-width="1.4" stroke-opacity=".8"/></svg>\n`;
}

for (const [k, v] of Object.entries(M)) fs.writeFileSync(path.join(OUT, k + ".svg"), v);
console.log("wrote " + Object.keys(M).map(k => k + ".svg").join(", "));
