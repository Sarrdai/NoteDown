// The screen lock (backlog #6, docs/requirements.md → "Privacy on the device"): in the Android app NoteDown
// locks with the system's PIN, pattern or biometrics when it starts and when it comes back after being away
// for the chosen time, like Signal's screen lock. Pure logic; the lock screen and the platform are ui/app-lock.js.

/** "Lock after" choices, in seconds away from the app. */
export const LOCK_AFTER = [
  [0, "Immediately"], [60, "After 1 minute"], [300, "After 5 minutes"],
  [900, "After 15 minutes"], [1800, "After 30 minutes"], [3600, "After 1 hour"],
];

export const DEFAULT_LOCK = { on: false, after: 0 };

/** The settings line: "Off" or the chosen time. */
export const lockSummary = lock => (lock.on ? LOCK_AFTER.find(([s]) => s === lock.after)?.[1] || "On" : "Off");

/**
 * Whether NoteDown locks on coming back: the lock is on, the app was hidden at `hiddenAt` (ms) and stayed
 * away at least the chosen time. `expected` (a share sheet or file picker NoteDown opened itself) never locks.
 */
export function lockDue(lock, hiddenAt, now, expected = false) {
  if (!lock || !lock.on || hiddenAt == null || expected) return false;
  return now - hiddenAt >= lock.after * 1000;
}
