// Every HTML page of the web app carries a Content-Security-Policy as a meta tag (docs/security-review.md, M2), so an
// escaping mistake in untrusted text can't run script. This notices a page that lost its policy, got an inline script
// or an on…= handler (which the policy would block), or a policy that lets scripts or plain http in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const APP = fileURLToPath(new URL("../app/", import.meta.url));

function pagesIn(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "vendor" || name === "node_modules" ? [] : pagesIn(path);
    return name.endsWith(".html") ? [path] : [];
  });
}

const pages = pagesIn(APP).map(path => ({ name: relative(APP, path), html: readFileSync(path, "utf8") }));

// { directive: [sources] } of the policy that follows the charset tag, or null.
function policyOf(html) {
  const m = /<meta charset="utf-8">\s*<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
  if (!m) return null;
  return Object.fromEntries(m[1].split(";").map(d => d.trim().split(/\s+/)).filter(d => d[0]).map(([name, ...sources]) => [name, sources]));
}

test("the pages are found", () => {
  assert.deepEqual(pages.map(p => p.name).sort(), ["admin/index.html", "delete/index.html", "import/index.html", "index.html", "invite/index.html", "privacy/index.html", "terms/index.html"]);
});

for (const { name, html } of pages) {
  test(`${name}: the policy sits right after the charset and shuts the doors that stay shut`, () => {
    const policy = policyOf(html);
    assert.ok(policy, "no <meta http-equiv=\"Content-Security-Policy\"> directly after <meta charset=\"utf-8\">");
    assert.deepEqual(policy["default-src"], ["'self'"]);
    for (const directive of ["object-src", "base-uri", "form-action", "frame-src"]) assert.deepEqual(policy[directive], ["'none'"], directive);
  });

  test(`${name}: scripts only from the app itself`, () => {
    const scripts = policyOf(html)["script-src"];
    assert.ok(scripts?.includes("'self'"), "script-src names 'self'");
    // Nothing that lets a string run: no inline script, no eval, no other host, no data: or blob: script.
    for (const source of scripts) assert.ok(["'self'", "'wasm-unsafe-eval'"].includes(source), `script-src allows ${source}`);
  });

  test(`${name}: no source that lets any host or plain http in, except the local test servers`, () => {
    for (const [directive, sources] of Object.entries(policyOf(html))) {
      for (const source of sources) {
        assert.ok(!/^(\*|http:|ws:|wss:)$/.test(source), `${directive} allows ${source}`);
        if (source.startsWith("http://")) assert.match(source, /^http:\/\/(localhost|127\.0\.0\.1):\*$/, `${directive} allows ${source}`);
      }
    }
  });

  test(`${name}: no inline script, on…= handler, javascript: address or embedded frame`, () => {
    assert.deepEqual(html.match(/<script\b(?![^>]*\ssrc=)[^>]*>/gi) ?? [], [], "an inline <script>");
    assert.deepEqual(html.match(/<[a-z][^>]*\son[a-z]+\s*=/gi) ?? [], [], "an on…= attribute");
    assert.deepEqual(html.match(/(?:href|src|action|formaction)\s*=\s*["']\s*javascript:/gi) ?? [], [], "a javascript: address");
    assert.deepEqual(html.match(/<(?:iframe|frame|object|embed|base)\b/gi) ?? [], []);
    for (const [, src] of html.matchAll(/<script\b[^>]*\ssrc="([^"]*)"/gi)) assert.ok(!/^[a-z]+:|^\/\//i.test(src), `a script from elsewhere: ${src}`);
  });
}
