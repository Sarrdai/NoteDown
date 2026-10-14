# NoteDown — Feature Backlog

LAST_ID: 20

Raw ideas only, not yet decided. Pick items up individually: an entry is
elaborated with the user, built into the prototype, and then leaves this file for
`docs/requirements.md` (concept phase) — later, once there is app code, it
leaves when it is implemented.

**IDs (`Nr`) are unique and permanent, not a sort order.** When adding a new
item, read `LAST_ID` above, add 1, use that value as the new entry's `Nr`,
then update `LAST_ID` to the same value — regardless of the priority you give
it. Removing or moving an entry never changes its `Nr`; removing an item
(e.g. because it was decided) does not change `LAST_ID` either — its ID is
simply retired, never reused. A requirement that came from an entry names
its `Nr` (`backlog #12`).

**Priority (`Prio`):**

- **1** — next / quick to settle.
- **2** — mid-term.
- **3** — long-term.
- **(empty)** — not planned, but not permanently rejected either; revisit later.
- **verworfen** — rejected, kept for documentation with the reason stated in
  `Begründung`. Adding a rejected entry requires a stated reason.

**Sorting:** by `Prio` (1, 2, 3, empty, then verworfen), then by `Nr` within
each priority. Re-sort after changing any priority.

**`Aufwand`** is a rough effort estimate (klein / mittel / groß).

**`Abhängig von`** — what has to be done first: another entry (`#n`), a
decided work item outside this file (e.g. milestone 2, `docs/requirements.md`
→ "Sync and sharing") or an external precondition. Empty means it can start
any time. An entry is not picked up before its dependency, whatever its
`Prio`; when an entry leaves this file, drop it from the other rows' column.
The column stays the last one, so a row added without it still reads right.

| Nr | Vorschlag | Begründung | Aufwand | Prio | Abhängig von |
|---|---|---|---|---|---|
| 8 | Rate limits per IP address on the server | Live test setup (2026-10-13): `docs/sync-and-sharing.md` → "Server" asks for them, but creating identities, relay slots and challenges is unlimited today. Open: a store shared across Cloud Run instances, or Google's load balancer / Cloud Armor (not free). Raised to 1: the live server is public, and it is the only open item that lets anyone fill the database. | klein | 1 |  |
| 15 | "Sign out this device" with local erase | Security review (2026-10-14): a device can't remove itself, and nothing clears its local data — after using a public PC the notes and device keys stay there and keep syncing until another device removes it. A button that takes the own device off the list and clears localStorage and IndexedDB. | klein | 1 |  |
| 17 | Pad file ciphertexts to fixed sizes | Security review (2026-10-14): AES-GCM adds only 28 bytes, so the server sees each file's exact size in bytes. Padding the plaintext to steps (e.g. 4 KiB) hides it; changes the file ciphertext format in `docs/server-api.md`. Raised to 1: a format change is cheapest before milestone 2 adds shared files. | klein | 1 |  |
| 1 | Reminders / notifications for due dates | Came up while scoping due dates (2026-10-13): a due date is shown as a chip today, but nothing reminds the user. Open: time of day, per note or global, platform notifications in the web app. | mittel | 2 |  |
| 4 | Verify a contact added by invitation link | Sync without accounts (2026-10-13): a contact scanned in person is verified, one added by link is only as safe as the messenger it came through. Scanning their code later, or comparing a short safety code, would verify it. | klein | 2 | milestone 2 |
| 12 | App icon and splash screen | Live test setup (2026-10-13): the Android test build still shows Capacitor's default icon and splash. Open: the icon itself (Catppuccin Mauve?), adaptive icon, web app manifest icon. | klein | 2 |  |
| 13 | Uptime monitoring and alerts for the live test | Live test setup (2026-10-13): nobody notices today when the server or the database is down. Google Cloud's uptime checks on `/health` with an email alert are free. Raised to 2: free and small, and nobody watches the live test otherwise. | klein | 2 |  |
| 16 | Temporary session (memory only) | Security review (2026-10-14): for a public PC, link by QR code and keep notes and keys only in memory, with the device taken off the list when the session ends. A private browser window already does most of this today; open: whether a mode of its own is worth it, and what happens when the tab is closed before signing out. | mittel | 2 | #15 |
| 18 | Device list only for authenticated callers | Security review (2026-10-14): `GET /v1/identities/{id}` needs no auth, so anyone who knows an identity ID can read its device count and when devices were added or removed. Open: contacts need the list in milestone 2 to wrap keys for each other's devices. Built together with milestone 2, which decides who counts as authenticated for a list. | klein | 2 | milestone 2 |
| 2 | Home-screen widget for quick capture | Quick capture from the phone's home screen (2026-10-13); app shortcuts "New note" / "Dictate" are planned for the app phase, a widget would go further (e.g. showing open notes). | mittel | 3 | app shortcuts (app phase) |
| 9 | Object store for the encrypted files | Live test setup (2026-10-13): Postgres holds the files for now; Neon's free plan has 0.5 GB. When files outgrow it, move them to an object store (e.g. Cloudflare R2, 10 GB free) behind the same API. | mittel | 3 |  |
| 10 | iOS app | Technology decision (2026-10-13): Android and web first. Capacitor's iOS project, an Apple developer account (99 $/year), signing and TestFlight for tests. Lowered to 3: Android and web first, milestone 2 before a third platform. | mittel | 3 | #12 |
| 11 | Play Store internal testing instead of APK downloads | Live test setup (2026-10-13): testers install the APK by hand today. The Play Console (25 $ once) gives automatic updates; needs a privacy policy page. | klein | 3 | #12, privacy policy page |
| 19 | Keep file keys as non-extractable CryptoKeys | Security review (2026-10-14): device keys are non-extractable, but file keys sit in IndexedDB as raw bytes (`app/js/sync/client.js`). Minor while the notes themselves are stored in plain text next to them. Lowered to 3: local notes stay plain-text Markdown by design, so the gain stays small. | klein | 3 |  |
| 20 | Post-quantum hybrid key wrapping | Security review (2026-10-14): file keys are wrapped with X25519 only, so a recorded server database could be decrypted by a future quantum computer ("harvest now, decrypt later"). X25519 + ML-KEM as in Signal's PQXDH, once WebCrypto offers ML-KEM in browsers and the Android web view. | groß | 3 | ML-KEM in WebCrypto (browsers and Android web view) |
| 3 | Optional email address to be found by | Sync is account-free (2026-10-13); an email the user adds voluntarily could let others find them without a link or QR code. Costs a mail service and gives the server a name. | mittel |  |  |
| 5 | "Reset identity" emergency button | Lost-device discussion (2026-10-13): if the recovery key itself may be compromised, a new identity with a new recovery key and new device keys; contacts then see a key change. Rarely needed, since removing a device already renews the file keys. | mittel |  | milestone 2 |
| 6 | App lock with PIN or biometrics | Lost-device discussion (2026-10-13): keys sit in the platform key store, but an unlocked phone still opens NoteDown. Open: on every start or after a timeout, web app included? | klein |  |  |
| 7 | Version history of the synced files | Lost-device discussion (2026-10-13): until a device is removed it can change or delete notes, shared ones included. The server could keep the encrypted versions of each file for e.g. 30 days, and the user could bring a state back. Open: how far back, per note or per file, storage per identity. | mittel |  | #9 |
