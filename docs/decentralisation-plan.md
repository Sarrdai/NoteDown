# Plan: decentralisation (backlog #28, #29)

Not decided — a plan for a later round (written 2026-10-14 against `main`
@ 33067fb). It turns the sketch in `docs/sync-and-sharing.md` → "Open
points" into what the current implementation would have to change and the
work packages to do it. The questions at the end come first: their
answers decide how big packages 2–4 are. Once the round has run, the
decisions live in the regular docs and this file is deleted.

## What assumes one server today

| Area | Today | Needs |
|---|---|---|
| `app/js/main.js` → `initSync` | One API URL from `app/config.json` or `?api=` | That URL becomes the **default** server; the identity's own **home server** is kept in the sync state |
| `app/js/sync/api.js` | One API client, one token | One client per server (URL → client), a token per server; offline and errors per server |
| `app/js/sync/client.js` | Device list, linking, restoring, removing, signing out on the one server | The home server holds the device list; every change is mirrored to every other server in use |
| `app/js/sync/files.js` | A slot per circle (`circleKey`), records `{id, version, base}`, one `listFiles()` per round, file keys in IndexedDB as `file:<id>` | Records `{server, id, version, base}`; `listFiles()` per server in use; keys as `file:<server>/<id>`; renewing keys per server and file; members' device lists read from the server the file lives on |
| One file per member set | The server answers 409 "file exists" — but only within one server | Two members creating the same set on two servers at once get two files: the client picks one deterministically and moves the other one's notes into it (moved markers) |
| `app/js/sync/contacts.js` | Invitations, requests and the contact list on the one server | Invitations on the own home server, named in the link; the requester talks to the inviter's home server; a contact pair must exist wherever a shared file is created (question 2) |
| `app/js/core/linking.js` | Invitation link `#v=1&id&s&name`; link code `slot&sign&enc&name`; relay message `{identity, name}` | Link with `srv` (the inviter's home server); link code with `srv` (where the slot is); relay message with the identity's home server — without it a newly linked device doesn't know where its identity lives. Missing values read as the default server (old links, test data) |
| `docs/file-format.md` → "Contacts" | `<!-- contact id name color pending -->` | `server=` (the contact's home server, percent-encoded; absent = default) |
| Server `POST /v1/identities` | Genesis entries only | A full chain, verified end to end, so a client can mirror an identity onto another server; the rest is appended via `/entries` |
| Server `PUT /v1/relay/{slot}` | Authenticated | The linking device may have no identity on the slot's server: fill unauthenticated (the payload is sealed, the slot is 16 random bytes and fills once) |
| Server contact pairs | Created only by confirming an invitation on that server | Question 2 |
| Server version | None | `GET /v1/info` → `{"api": 1}`; the client refuses an incompatible server with a clear message |
| CORS | `CORS_ORIGINS` already configurable | Documented for self-hosting (`docs/operations.md`) |
| Restoring | Finds the identity on the configured server | The default server or one the user enters; the other servers follow from the private file and the contacts |
| Sample (`app/js/sync-sim.js`) | One simulated server | Simulated servers for the UI variants |
| `scripts/test-sync.sh` | One server on port 8765 | Two servers with their own databases |

Unchanged: the crypto primitives, the merge logic (`app/js/core/merge.js`),
the notes file apart from new marker attributes, quota and rate limits
(per server).

## Work packages

Order: 1 → (2 ∥ 4) → 3 → 5. Package 1 depends on none of the questions.

1. **#28 groundwork** (small; a Sonnet session is enough): link, link
   code, relay message and contact marker carry the server; the home
   server in the sync state; file records and stored file keys addressed
   by server + file ID, with a one-time migration of what a device stored
   already; every API call goes through the server of its record or
   contact (still always the default in practice). Unit tests; docs
   (`server-api.md`, `file-format.md`, `sync-and-sharing.md`); backlog
   #28 retired. `scripts/test-sync.sh` stays green, no behaviour change.
2. **#29 server** (Opus: protocol design): full-chain identities,
   contact pairs per question 2, the relay fill, `GET /v1/info`, a notice
   inbox if question 1 picks free choice. Server tests,
   `docs/server-api.md`.
3. **#29 multi-server client** (Opus; after 2): a sync round over all
   servers in use; mirroring the device list after every change and on
   first use of a server; renewing keys per server (a server that is
   down keeps its entries on the renew list); restoring with an entered
   home server; linking across servers; duplicate set files. End-to-end
   test with two servers: sharing between A (home S1) and B (home S2),
   removing a device renews on both, restoring from S2.
4. **#29 UI** (Opus, variants; can run beside 2 on the sample): where
   the home server is set (turning on sync, restoring), choosing the
   server when sharing with a new set of people (only shown when there is
   a choice), sync status and storage per server in Sync & sharing — in
   every tier.
5. **Wrap-up** (lead): self-hosting in `docs/operations.md` (Docker image,
   `CORS_ORIGINS`, Postgres), `README.md`, `docs/requirements.md`,
   backlog #29 retired, leftovers as new backlog entries, this file
   deleted.

## Questions to settle first

1. **How free is the choice of server?** Recommended: a shared file lives
   on the home server of one of its members, by default the sharer's.
   Every member then finds it by asking its contacts' home servers — no
   server list, no notices, and self-hosting is fully covered.
   Alternative: a freely kept server list, which needs an encrypted notice
   inbox on each member's home server so the members learn about a new
   file.
2. **How does a contact pair get onto another server?** Recommended: a
   portable contact proof — on confirming, a device of each side signs
   "A and B are contacts"; any server checks the two signatures against
   the mirrored device lists. Alternative: confirm again through every
   further server, which is clumsier for the user.
3. **Moving the home server** (taking the private file along)?
   Recommended: not in this round; a new backlog entry.
4. **Running the round:** recommended as package sessions
   (`package-sessions` skill) — package 1 first, packages 2 and 4 once the
   questions are answered, package 3 after 2.
5. **Home server on the recovery key sheet** when it isn't the default?
   Restoring with the key alone only finds the default server.
   Recommended: yes.
