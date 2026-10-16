#!/usr/bin/env node
// Writes app/licenses.json, the third-party components and their license
// texts shown under Settings → About → Open-source licenses. Run it by hand
// after changing a pinned version (scripts/vendor/package.json,
// mobile/package.json, mobile/android/variables.gradle), re-vendoring a
// library (app/vendor/) or adding a component to the list in
// app/js/core/licenses.js, and commit the output. Reads repo files only (no
// node_modules); tests/licenses.test.mjs fails when the file is stale.
//
//   node scripts/make-licenses.js           # write
//   node scripts/make-licenses.js --check   # exit 1 when the file is out of date
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "app/licenses.json");
const read = p => fs.readFileSync(path.join(ROOT, p), "utf8");

async function generate() {
  const { buildLicenses } = await import("../app/js/core/licenses.js");
  const data = buildLicenses({
    vendorPackage: JSON.parse(read("scripts/vendor/package.json")),
    mobilePackage: JSON.parse(read("mobile/package.json")),
    variablesGradle: read("mobile/android/variables.gradle"),
    markedJs: read("app/vendor/marked.esm.js"),
    catppuccinCss: read("app/css/catppuccin.css"),
    capacitorLicense: read("app/vendor/capacitor-core.LICENSE"),
    codemirrorLicense: read("app/vendor/codemirror.LICENSE"),
    jsqrLicense: read("app/vendor/jsqr.LICENSE"),
    markedLicense: read("app/vendor/marked.LICENSE.md"),
    qrcodeLicense: read("app/vendor/qrcode.LICENSE"),
    catppuccinLicense: read("app/vendor/catppuccin-palette.LICENSE"),
  });
  return JSON.stringify(data, null, 1) + "\n";
}

generate().then(json => {
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
    if (current !== json) { console.error("app/licenses.json is out of date: run node scripts/make-licenses.js"); process.exit(1); }
    console.log("app/licenses.json is up to date");
  } else {
    fs.writeFileSync(OUT, json);
    console.log(`wrote app/licenses.json (${JSON.parse(json).entries.length} components)`);
  }
}).catch(e => { console.error(e.message); process.exit(1); });
