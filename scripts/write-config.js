#!/usr/bin/env node
// Writes app/config.json for a deploy (docs/operations.md), run by the Web and Android workflows. Every
// value comes from the environment and is left out when empty:
//   API_HOST, WEB_HOST                     → "api", "web" (https:// + host; checked by scripts/check-host.sh)
//   OPERATOR_NAME, OPERATOR_EMAIL,
//   OPERATOR_ADDRESS                       → "operator" (the privacy policy and terms of use, app/legal/legal.js;
//                                             the address may hold "\n" for line breaks)
//   APP_VERSION                            → "version" (Settings → About)
//   GITHUB_SERVER_URL + GITHUB_REPOSITORY  → "source" (Settings → About → Source code)
const fs = require("fs");
const path = require("path");

const env = name => (process.env[name] || "").trim();
const config = {};
if (env("API_HOST")) config.api = `https://${env("API_HOST")}`;
if (env("WEB_HOST")) config.web = `https://${env("WEB_HOST")}`;
const operator = {
  name: env("OPERATOR_NAME"),
  email: env("OPERATOR_EMAIL"),
  address: env("OPERATOR_ADDRESS").replace(/\\n/g, "\n"),
};
for (const key of Object.keys(operator)) if (!operator[key]) delete operator[key];
if (Object.keys(operator).length) config.operator = operator;
if (env("APP_VERSION")) config.version = env("APP_VERSION");
if (env("GITHUB_REPOSITORY")) config.source = `${env("GITHUB_SERVER_URL") || "https://github.com"}/${env("GITHUB_REPOSITORY")}`;

const file = path.join(__dirname, "..", "app", "config.json");
fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
console.log(`app/config.json: ${Object.keys(config).join(", ") || "(empty)"}`);
