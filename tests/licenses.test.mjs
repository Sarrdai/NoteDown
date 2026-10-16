import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildLicenses, parseGradleVariables } from "../app/js/core/licenses.js";

const read = p => fs.readFileSync(new URL("../" + p, import.meta.url), "utf8");
const inputs = () => ({
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

test("app/licenses.json is up to date with the pinned versions", () => {
  const built = JSON.stringify(buildLicenses(inputs()), null, 1) + "\n";
  assert.equal(read("app/licenses.json"), built, "run node scripts/make-licenses.js");
});

test("a version bump changes the list", () => {
  const files = inputs();
  files.mobilePackage.dependencies["@capacitor/app"] = "9.0.0";
  files.vendorPackage.devDependencies.jsqr = "2.0.0";
  files.variablesGradle = files.variablesGradle.replace(/androidxCoreVersion = '[^']+'/, "androidxCoreVersion = '9.9.9'");
  const { entries } = buildLicenses(files);
  const version = name => entries.find(e => e.name === name).version;
  assert.equal(version("Capacitor App plugin"), "9.0.0");
  assert.equal(version("jsQR"), "2.0.0");
  assert.equal(version("AndroidX Core"), "9.9.9");
});

test("every entry has a version, a license and a known text", () => {
  const { texts, entries } = buildLicenses(inputs());
  for (const e of entries) {
    assert.match(e.version, /^\d+\.\d+/, e.name);
    assert.ok(e.license && e.url && texts[e.text], e.name);
    assert.ok(["web+android", "android"].includes(e.platform), e.name);
  }
  assert.ok(entries.some(e => e.platform === "web+android") && entries.some(e => e.platform === "android"));
});

test("parses the ext block of variables.gradle", () => {
  assert.deepEqual(parseGradleVariables("ext {\n  a = '1.0'\n  minSdkVersion = 24\n  b = \"2\"\n}"), { a: "1.0", b: "2" });
});
