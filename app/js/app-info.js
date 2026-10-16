// What app/config.json says about this build besides the sync server: the
// version (written by the deploy workflows) and the source code address,
// for Settings → About. Set once at startup (main.js), read by the UI.
export const SOURCE_URL = "https://github.com/Sarrdai/NoteDown";

let info = { version: "", source: SOURCE_URL };

export function setAppInfo(config = {}) {
  info = { version: String(config.version || ""), source: String(config.source || SOURCE_URL) };
}

export const appInfo = () => info;
