import { test } from "node:test";
import assert from "node:assert/strict";
import { externalPolicy, setCirclePolicy, mediaSource, mediaKind, splitAddress, DEFAULT_EXTERNAL } from "../app/js/core/external.js";
import { renderMarkdown } from "../app/js/core/markdown.js";

test("externalPolicy: the default, overridden per circle and per kind", () => {
  assert.deepEqual(externalPolicy(undefined, ""), { media: "click", links: "confirm" });
  const s = { media: "auto", links: "open", circles: { "lea": { media: "never" } } };
  assert.deepEqual(externalPolicy(s, "lea"), { media: "never", links: "open" });
  assert.deepEqual(externalPolicy(s, "tom"), { media: "auto", links: "open" });
  assert.deepEqual(externalPolicy(s, null), { media: "auto", links: "open" });
});

test("setCirclePolicy sets and clears a circle's choice, dropping an empty circle", () => {
  let s = setCirclePolicy(DEFAULT_EXTERNAL, "", "links", "off");
  assert.deepEqual(s.circles, { "": { links: "off" } });
  s = setCirclePolicy(s, "", "media", "auto");
  assert.deepEqual(s.circles, { "": { links: "off", media: "auto" } });
  s = setCirclePolicy(setCirclePolicy(s, "", "links", null), "", "media", null);
  assert.deepEqual(s.circles, {});
  assert.deepEqual(DEFAULT_EXTERNAL.circles, {});
});

test("mediaSource loads http(s) only; mediaKind tells videos by extension", () => {
  assert.equal(mediaSource("https://example.org/a b.png"), "https://example.org/a%20b.png");
  assert.equal(mediaSource("javascript:alert(1)"), null);
  assert.equal(mediaSource("data:image/png;base64,AAAA"), null);
  assert.equal(mediaSource("pic.png"), null);
  assert.equal(mediaKind("https://example.org/clip.MP4?x=1"), "video");
  assert.equal(mediaKind("https://example.org/clip.png"), "image");
});

test("splitAddress puts the host apart, also behind a user part", () => {
  assert.deepEqual(splitAddress("https://example.org/a?b"), { before: "https://", host: "example.org", after: "/a?b" });
  assert.deepEqual(splitAddress("https://bank.com@evil.example/x"), { before: "https://bank.com@", host: "evil.example", after: "/x" });
  assert.deepEqual(splitAddress("mailto:a@b.c"), { before: "", host: "", after: "mailto:a@b.c" });
});

test("an embedded image renders as a placeholder, never as <img>", () => {
  const html = renderMarkdown('![Tram "28"](https://example.org/tram.jpg)');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /class="ext-media" data-kind="image" data-src="https:\/\/example.org\/tram.jpg" data-alt="Tram &quot;28&quot;"/);
  assert.match(renderMarkdown("![](https://example.org/c.webm)"), /data-kind="video"/);
  assert.doesNotMatch(renderMarkdown("![x](javascript:alert(1))"), /data-src/);
});
