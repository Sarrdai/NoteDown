# NoteDown — Feature Backlog

LAST_ID: 4

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

**Priority (`Prio`) — the rightmost column:**

- **1** — next / quick to settle.
- **2** — mid-term.
- **3** — long-term.
- **(empty)** — not planned, but not permanently rejected either; revisit later.
- **verworfen** — rejected, kept for documentation with the reason stated in
  `Begründung`. Adding a rejected entry requires a stated reason.

**Sorting:** by `Prio` (1, 2, 3, empty, then verworfen), then by `Nr` within
each priority. Re-sort after changing any priority.

**`Aufwand`** is a rough effort estimate (klein / mittel / groß).

| Nr | Vorschlag | Begründung | Aufwand | Prio |
|---|---|---|---|---|
| 1 | Reminders / notifications for due dates | Came up while scoping due dates (2026-10-13): a due date is shown as a chip today, but nothing reminds the user. Open: time of day, per note or global, platform notifications in the web app. | mittel | 2 |
| 4 | Verify a contact added by invitation link | Sync without accounts (2026-10-13): a contact scanned in person is verified, one added by link is only as safe as the messenger it came through. Scanning their code later, or comparing a short safety code, would verify it. | klein | 2 |
| 2 | Home-screen widget for quick capture | Quick capture from the phone's home screen (2026-10-13); app shortcuts "New note" / "Dictate" are planned for the app phase, a widget would go further (e.g. showing open notes). | mittel | 3 |
| 3 | Optional email address to be found by | Sync is account-free (2026-10-13); an email the user adds voluntarily could let others find them without a link or QR code. Costs a mail service and gives the server a name. | mittel | |
