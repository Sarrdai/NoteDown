// The hint that the notes live only in this browser (web app, sync off):
// shown until the user hides it, then back after HINT_PAUSE_DAYS.
export const HINT_PAUSE_DAYS = 14;

const dayNumber = day => Date.UTC(...day.split("-").map((n, i) => Number(n) - (i === 1 ? 1 : 0))) / 86400000;

/** Whether the hint shows: in a browser (not the app) with sync off, unless
 *  hidden on `hiddenOn` ("YYYY-MM-DD") fewer than HINT_PAUSE_DAYS before `today`. */
export function showStorageHint({ native, syncOn, hiddenOn, today }) {
  if (native || syncOn) return false;
  return !hiddenOn || dayNumber(today) - dayNumber(hiddenOn) >= HINT_PAUSE_DAYS;
}
