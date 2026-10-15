# NoteDown — Feature Backlog

LAST_ID: 34

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
| 30 | Setting for links and images in notes | Security question (2026-10-14): any member of a shared note can add an image from another host, which every reader's device loads (that host sees IP address and reading time), and links lead anywhere. Links and images stay a wanted feature; a setting decides per source: **allowed**, **only after confirming** or **never** — global, overridable per circle (group), so the client blocks them. Open: synced or per device; does it apply to private notes; how "after confirming" looks (placeholder with the host to tap, a dialog with the full address before a link opens). | mittel | 1 |  |
| 31 | Import of exported files | Export concept (2026-10-14): an export with metadata keeps the note markers, so it could be read back to restore notes. Not planned yet; whether it is worth it (and how ids that already exist are handled) is to be discussed. | mittel | 2 |  |
| 32 | Integrity of the local file in the app phase | Security question (2026-10-14): whoever can write the local private file acts as the user — e.g. set `verified=` on a contact, or swap two contacts' `id`s so notes "shared with Lea" go to Tom (the server only refuses non-contacts); the change syncs to all own devices. Today the notes sit in browser storage, reachable only with developer tools; it matters once the app keeps them in the visible documents folder (`docs/requirements.md` → "Notes and storage"). Options: keep the files app-private and rely on Export for a readable copy, or keep security-relevant state (verification, contact ids) outside the editable file. Also to check: a member of a shared file could write a note with the id of one of the user's private notes (e.g. one that was shared before); the store looks notes up by id only. | mittel | 2 |  |
| 33 | Paid plans for the default server | Admin dashboard (2026-10-15): the dashboard can already set a storage limit per identity by hand (`docs/requirements.md` → "Server maintenance (admin)"). A purchase (e.g. Play Billing, its token checked by the server) would set the same per-identity limit, and later other paid features (version history #7), without the server learning a name. Open: which features, price, how the web app buys, what happens when a plan ends while over the limit. | mittel | 2 | #11 for Play Billing |
| 2 | Home-screen widget for quick capture | Quick capture from the phone's home screen (2026-10-13); app shortcuts "New note" / "Dictate" are planned for the app phase, a widget would go further (e.g. showing open notes). | mittel | 3 | app shortcuts (app phase) |
| 9 | Object store for the encrypted files | Live test setup (2026-10-13): Postgres holds the files for now; Neon's free plan has 0.5 GB. When files outgrow it, move them to an object store (e.g. Cloudflare R2, 10 GB free) behind the same API. | mittel | 3 |  |
| 10 | iOS app | Technology decision (2026-10-13): Android and web first. Capacitor's iOS project, an Apple developer account (99 $/year), signing and TestFlight for tests. Lowered to 3: Android and web first, milestone 2 before a third platform. | mittel | 3 |  |
| 11 | Play Store internal testing instead of APK downloads | Live test setup (2026-10-13): testers install the APK by hand today. The Play Console (25 $ once) gives automatic updates; needs a privacy policy page. | klein | 3 | privacy policy page |
| 19 | Keep file keys as non-extractable CryptoKeys | Security review (2026-10-14): device keys are non-extractable, but file keys sit in IndexedDB as raw bytes (`app/js/sync/client.js`). Minor while the notes themselves are stored in plain text next to them. Lowered to 3: local notes stay plain-text Markdown by design, so the gain stays small. | klein | 3 |  |
| 20 | Post-quantum hybrid key wrapping | Security review (2026-10-14): file keys are wrapped with X25519 only, so a recorded server database could be decrypted by a future quantum computer ("harvest now, decrypt later"). X25519 + ML-KEM as in Signal's PQXDH, once WebCrypto offers ML-KEM in browsers and the Android web view. | groß | 3 | ML-KEM in WebCrypto (browsers and Android web view) |
| 22 | Push from the server when a file changed (Android) | Question on push instead of polling (2026-10-14): a data-only message through Firebase Cloud Messaging ("file changed", no content) would let the app sync only when there is something new, even in the background, and matters most once others change shared notes (milestone 2). Costs: a Firebase project, the server stores a push token per device, and Google sees when a device gets one; needs Google Play services. The web stays on polling: Web Push in Chrome has to show a visible notification for every push, and an open connection keeps a Cloud Run instance billed (`docs/sync-and-sharing.md` → "Sync"). | mittel | 3 |  |
| 29 | Choose the sync server per circle of people | Decentralisation discussion (2026-10-14): the default server stays the default, but a user can keep a list of servers and pick one when sharing with a new set of people; the private file stays on the own home server. No server sees the whole sharing graph any more, and self-hosting becomes possible. Clients talk to several servers, servers don't federate. Sketch and open questions: `docs/sync-and-sharing.md` → "Open points"; implementation plan: `docs/decentralisation-plan.md` (its groundwork, #28, is done). | groß | 3 |
| 34 | Delete or block an identity from the admin dashboard | Admin dashboard (2026-10-15): for test data and abuse. Open: what happens to shared files whose fixed member set includes the identity (the other members keep reading them), whether blocking is enough, and how the user learns about it. | mittel | 3 |  |
| 3 | Optional email address to be found by | Sync is account-free (2026-10-13); an email the user adds voluntarily could let others find them without a link or QR code. Costs a mail service and gives the server a name. | mittel |  |  |
| 5 | "Reset identity" emergency button | Lost-device discussion (2026-10-13): if the recovery key itself may be compromised, a new identity with a new recovery key and new device keys; contacts then see a key change. Rarely needed, since removing a device already renews the file keys. | mittel |  |  |
| 6 | App lock with PIN or biometrics | Lost-device discussion (2026-10-13): keys sit in the platform key store, but an unlocked phone still opens NoteDown. Open: on every start or after a timeout, web app included? | klein |  |  |
| 7 | Version history of the synced files | Lost-device discussion (2026-10-13): until a device is removed it can change or delete notes, shared ones included. The server could keep the encrypted versions of each file for e.g. 30 days, and the user could bring a state back. Open: how far back, per note or per file, storage per identity. Old versions are encrypted with older file keys, so removing a device must keep the old keys readable for the remaining devices. Could be a paid option on the default server (2026-10-14): a Play Billing purchase token sent to the server and checked there marks the identity, so all its devices (web included) get it, and restoring with the recovery key keeps it; the server still learns no name. | mittel |  | #9; #11 for a paid option |
| 16 | Temporary session (memory only) | Security review (2026-10-14): for a public PC, link by QR code and keep notes and keys only in memory, with the device taken off the list when the session ends. Rejected with the user (2026-10-14): a private browser window plus "Sign out this device" with local erase (#15) already cover the public-PC case, a mode of its own isn't worth it. | mittel | verworfen |  |
