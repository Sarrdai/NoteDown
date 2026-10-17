// The list of third-party components shipped in the app (Settings → About →
// Open-source licenses), built from the repo's own files by
// scripts/make-licenses.js into app/licenses.json. DOM-free: takes the file
// contents, returns the list. `texts` holds each license text once, entries
// point to it by key.

const MIT_CAPACITOR = "mit-capacitor";
const APACHE = "apache-2.0";
const BOTH = "web+android";

const ANDROIDX = [
  ["androidxAppCompatVersion", "AndroidX AppCompat", "https://developer.android.com/jetpack/androidx/releases/appcompat"],
  ["androidxCoordinatorLayoutVersion", "AndroidX CoordinatorLayout", "https://developer.android.com/jetpack/androidx/releases/coordinatorlayout"],
  ["coreSplashScreenVersion", "AndroidX Core SplashScreen", "https://developer.android.com/jetpack/androidx/releases/core"],
  ["androidxCoreVersion", "AndroidX Core", "https://developer.android.com/jetpack/androidx/releases/core"],
  ["androidxActivityVersion", "AndroidX Activity", "https://developer.android.com/jetpack/androidx/releases/activity"],
  ["androidxFragmentVersion", "AndroidX Fragment", "https://developer.android.com/jetpack/androidx/releases/fragment"],
  ["androidxWebkitVersion", "AndroidX WebKit", "https://developer.android.com/jetpack/androidx/releases/webkit"],
  ["androidxBiometricVersion", "AndroidX Biometric", "https://developer.android.com/jetpack/androidx/releases/biometric"],
];

/** `name = 'value'` pairs of the `ext { }` block of variables.gradle. */
export function parseGradleVariables(source) {
  const out = {};
  for (const m of source.matchAll(/^\s*(\w+)\s*=\s*['"]([^'"]+)['"]/gm)) out[m[1]] = m[2];
  return out;
}

function need(value, what) {
  if (!value) throw new Error(`licenses: ${what} not found`);
  return value;
}

/**
 * `files`: { vendorPackage (parsed scripts/vendor/package.json), mobilePackage
 * (parsed mobile/package.json), variablesGradle (text), markedJs (text),
 * catppuccinCss (text), and the license texts: capacitorLicense,
 * codemirrorLicense, jsqrLicense (Apache-2.0), markedLicense, qrcodeLicense,
 * catppuccinLicense }. Returns { texts, entries }.
 */
export function buildLicenses(files) {
  const dev = files.vendorPackage.devDependencies;
  const mobile = files.mobilePackage.dependencies;
  const gradle = parseGradleVariables(files.variablesGradle);
  const markedVersion = need(/marked v([\d.]+)/.exec(files.markedJs)?.[1], "marked version");
  const catppuccinVersion = need(/@catppuccin\/palette ([\d.]+)/.exec(files.catppuccinCss)?.[1], "Catppuccin version");

  const texts = {
    "mit-marked": files.markedLicense,
    "mit-codemirror": files.codemirrorLicense,
    "mit-qrcode": files.qrcodeLicense,
    "mit-catppuccin": files.catppuccinLicense,
    [MIT_CAPACITOR]: files.capacitorLicense,
    [APACHE]: files.jsqrLicense,
  };

  const entry = platform => (name, version, license, url, text) => ({ name, version: need(version, name), license, url, platform, text });
  const web = entry(BOTH), android = entry("android");
  const entries = [
    web("marked", markedVersion, "MIT", "https://github.com/markedjs/marked", "mit-marked"),
    web("CodeMirror", dev["@codemirror/view"], "MIT", "https://codemirror.net", "mit-codemirror"),
    web("Lezer", dev["@lezer/common"], "MIT", "https://lezer.codemirror.net", "mit-codemirror"),
    web("jsQR", dev.jsqr, "Apache-2.0", "https://github.com/cozmo/jsQR", APACHE),
    web("qrcode-generator", dev["qrcode-generator"], "MIT", "https://github.com/kazuhikoarase/qrcode-generator", "mit-qrcode"),
    web("Capacitor", dev["@capacitor/core"], "MIT", "https://capacitorjs.com", MIT_CAPACITOR),
    web("Catppuccin palette", catppuccinVersion, "MIT", "https://catppuccin.com", "mit-catppuccin"),
    android("Capacitor Android", mobile["@capacitor/android"], "MIT", "https://capacitorjs.com", MIT_CAPACITOR),
    android("Capacitor App plugin", mobile["@capacitor/app"], "MIT", "https://capacitorjs.com", MIT_CAPACITOR),
    android("Capacitor Local Notifications plugin", mobile["@capacitor/local-notifications"], "MIT", "https://capacitorjs.com", MIT_CAPACITOR),
    ...ANDROIDX.map(([variable, name, url]) => android(name, gradle[variable], "Apache-2.0", url, APACHE)),
    android("Apache Cordova (Android)", gradle.cordovaAndroidVersion, "Apache-2.0", "https://cordova.apache.org", APACHE),
  ];
  return { texts, entries };
}
