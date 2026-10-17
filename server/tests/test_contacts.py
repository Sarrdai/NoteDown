"""Invitations, contacts and who may read a device list (docs/server-api.md → "Contacts and
invitations"; backlog #18)."""

import hashlib
import os

import psycopg

from notedown_server.protocol import b64u, invitation_message

from conftest import DATABASE_URL, Keys
from test_api import upload


def expire(iid: str, interval: str = "1 minute") -> None:
    with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
        conn.execute("UPDATE invitations SET expires = now() - %s::interval WHERE id = %s", (interval, iid))


# --- creating invitations ---


def test_invitation_is_created_with_a_signature_of_the_calling_device(people):
    alice = people()
    iid, r = alice.invite("code")
    assert r.status_code == 201
    listed = alice.client.get("/v1/invitations", headers=alice.h).json()["invitations"]
    assert [(i["id"], i["kind"], i["device"], i["request"]) for i in listed] == [
        (iid, "code", alice.phone.id, None)]
    assert listed[0]["sig"] == b64u(alice.phone.sign_key.sign(invitation_message(iid)))


def test_invitation_with_a_wrong_signature_is_refused(people):
    alice = people()
    iid = b64u(os.urandom(16))
    for signer in (Keys(), alice.recovery):   # a stranger's key, another device of the identity
        sig = b64u(signer.sign_key.sign(invitation_message(iid)))
        r = alice.client.post("/v1/invitations", json={"id": iid, "kind": "code", "sig": sig}, headers=alice.h)
        assert r.status_code == 400
    # A signature over another invitation ID doesn't fit either.
    sig = b64u(alice.phone.sign_key.sign(invitation_message(b64u(os.urandom(16)))))
    assert alice.client.post("/v1/invitations", json={"id": iid, "kind": "code", "sig": sig},
                             headers=alice.h).status_code == 400
    assert alice.client.get("/v1/invitations", headers=alice.h).json() == {"invitations": []}


def test_invitation_must_be_signed_by_the_device_that_calls(people):
    alice = people()
    laptop = alice.add_device()
    iid, r = alice.invite(device=laptop)       # the phone calls, the laptop signed
    assert r.status_code == 400
    iid, r = alice.invite(device=laptop, headers=alice.sign_in(laptop))
    assert r.status_code == 201
    # The other device of the identity sees who signed.
    listed = alice.client.get("/v1/invitations", headers=alice.h).json()["invitations"]
    assert listed[0]["device"] == laptop.id


def test_invitation_id_kind_and_signature_are_validated(people):
    alice = people()
    good = b64u(os.urandom(16))
    sig = b64u(alice.phone.sign_key.sign(invitation_message(good)))
    for body in ({"id": "short", "kind": "code", "sig": sig}, {"id": good, "kind": "other", "sig": sig},
                 {"id": good, "kind": "code", "sig": "x"}):
        assert alice.client.post("/v1/invitations", json=body, headers=alice.h).status_code == 400
    assert alice.client.post("/v1/invitations", json={"id": good, "kind": "code", "sig": sig}).status_code == 401


def test_invitation_id_exists_once(people):
    alice, bob = people(), people()
    secret = os.urandom(16)
    assert alice.invite(secret=secret)[1].status_code == 201
    assert alice.invite(secret=secret)[1].status_code == 409
    assert bob.invite(secret=secret)[1].status_code == 409


def test_invitation_lifetimes(people):
    alice = people()
    with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
        _, code = alice.invite("code")
        _, link = alice.invite("link")
        assert code.status_code == link.status_code == 201
        minutes = {k: conn.execute("SELECT round(extract(epoch FROM expires - now()) / 60) FROM invitations "
                                   "WHERE kind = %s", (k,)).fetchone()[0] for k in ("code", "link")}
    assert minutes == {"code": 10, "link": 7 * 24 * 60}


def test_twenty_open_invitations_at_most(people):
    alice, bob = people(), people()
    ids = [alice.invite()[0] for _ in range(20)]
    r = alice.invite()[1]
    assert r.status_code == 413
    assert bob.invite()[1].status_code == 201                 # per identity
    expire(ids[0])                                             # an expired one doesn't count
    assert alice.invite()[1].status_code == 201
    alice.client.delete(f"/v1/invitations/{ids[1]}", headers=alice.h)   # nor a withdrawn one
    assert alice.invite()[1].status_code == 201
    assert alice.invite()[1].status_code == 413


def test_expired_invitations_are_gone(people):
    alice, bob = people(), people()
    iid, _ = alice.invite()
    expire(iid)
    assert alice.client.get("/v1/invitations", headers=alice.h).json() == {"invitations": []}
    assert bob.request(iid, alice).status_code == 404
    assert bob.identity_status(alice.id, iid) == 404


# --- requesting, confirming, declining ---


def test_request_confirm_makes_contacts_and_deletes_the_invitation(people):
    alice, bob = people(), people()
    iid, _ = alice.invite()
    assert bob.request(iid, alice).status_code == 204

    listed = alice.client.get("/v1/invitations", headers=alice.h).json()["invitations"]
    assert listed[0]["request"] == {"identity": bob.id, "card": b64u(b"card-phone")}
    assert alice.client.get("/v1/contacts", headers=alice.h).json() == {"contacts": []}

    r = alice.confirm(iid)
    assert r.status_code == 201 and r.json() == {"identity": bob.id}
    assert alice.client.get("/v1/contacts", headers=alice.h).json() == {"contacts": [bob.id]}
    assert bob.client.get("/v1/contacts", headers=bob.h).json() == {"contacts": [alice.id]}
    assert alice.client.get("/v1/invitations", headers=alice.h).json() == {"invitations": []}
    assert alice.confirm(iid).status_code == 404               # only once


def test_each_device_gets_its_own_card_and_null_without_one(people):
    alice, bob = people(), people()
    laptop = alice.add_device()
    iid, _ = alice.invite()
    cards = {alice.phone.id: b64u(b"for-phone"), laptop.id: b64u(b"for-laptop")}
    assert bob.request(iid, alice, cards).status_code == 204
    cards_of = lambda headers: alice.client.get("/v1/invitations", headers=headers).json()["invitations"][0]["request"]["card"]
    assert cards_of(alice.h) == b64u(b"for-phone")
    assert cards_of(alice.sign_in(laptop)) == b64u(b"for-laptop")
    assert cards_of(alice.sign_in(alice.recovery)) is None


def test_a_request_needs_valid_cards_for_active_devices_of_the_inviter(people):
    alice, bob = people(), people()
    iid, _ = alice.invite()
    ok = b64u(b"card")
    for cards in ({}, {Keys().id: ok}, {bob.phone.id: ok}, {alice.phone.id: "a+b/"},
                  {alice.phone.id: b64u(b"x" * 1600)}):    # 1600 bytes are 2134 characters
        assert bob.request(iid, alice, cards).status_code == 400, cards
    laptop = alice.add_device()
    entry = alice.identity.entry("remove", {"id": laptop.id}, signer=alice.phone)
    alice.client.post(f"/v1/identities/{alice.id}/entries", json={"entry": entry}, headers=alice.h)
    assert bob.request(iid, alice, {laptop.id: ok}).status_code == 400        # removed device
    assert bob.request(iid, alice, {alice.phone.id: b64u(b"x" * 380)}).status_code == 204   # 507 characters


def test_only_one_request_and_never_from_the_inviter(people):
    alice, bob, carol = people(), people(), people()
    iid, _ = alice.invite()
    assert alice.request(iid, alice).status_code == 403
    assert bob.request(iid, alice).status_code == 204
    assert carol.request(iid, alice).status_code == 409
    assert alice.request(iid, alice).status_code == 403
    assert bob.request(b64u(os.urandom(16)), alice).status_code == 404
    assert alice.client.post(f"/v1/invitations/{iid}/request", json={"cards": {}}).status_code == 401


def test_a_request_waits_for_the_decision_up_to_30_days(people):
    alice, bob = people(), people()
    iid, _ = alice.invite()
    assert bob.request(iid, alice).status_code == 204
    expire(iid, "40 days")                                     # the invitation itself ran out long ago
    assert len(alice.client.get("/v1/invitations", headers=alice.h).json()["invitations"]) == 1
    with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
        conn.execute("UPDATE invitations SET requested_at = now() - interval '31 days'")
    assert alice.client.get("/v1/invitations", headers=alice.h).json() == {"invitations": []}
    assert alice.confirm(iid).status_code == 404


def test_confirm_needs_a_request_on_an_own_invitation(people):
    alice, bob, carol = people(), people(), people()
    iid, _ = alice.invite()
    assert alice.confirm(iid).status_code == 404               # no request yet
    bob.request(iid, alice)
    assert bob.confirm(iid).status_code == 404                 # the requester can't confirm
    assert carol.confirm(iid).status_code == 404
    assert alice.confirm(b64u(os.urandom(16))).status_code == 404
    assert alice.client.get("/v1/contacts", headers=alice.h).json() == {"contacts": []}


def test_decline_and_withdraw_delete_the_invitation(people):
    alice, bob, carol = people(), people(), people()
    declined, _ = alice.invite()
    bob.request(declined, alice)
    withdrawn, _ = alice.invite()
    assert alice.client.delete(f"/v1/invitations/{declined}", headers=alice.h).status_code == 204
    assert alice.client.delete(f"/v1/invitations/{withdrawn}", headers=alice.h).status_code == 204
    assert alice.client.get("/v1/invitations", headers=alice.h).json() == {"invitations": []}
    assert alice.confirm(declined).status_code == 404
    assert carol.request(withdrawn, alice).status_code == 404
    assert alice.client.get("/v1/contacts", headers=alice.h).json() == {"contacts": []}


def test_only_the_inviter_can_delete_an_invitation(people):
    alice, bob = people(), people()
    iid, _ = alice.invite()
    assert bob.client.delete(f"/v1/invitations/{iid}", headers=bob.h).status_code == 204
    assert len(alice.client.get("/v1/invitations", headers=alice.h).json()["invitations"]) == 1
    assert bob.client.delete(f"/v1/invitations/{iid}").status_code == 401


def test_invitations_are_private_to_the_inviter(people):
    alice, bob = people(), people()
    alice.invite()
    assert bob.client.get("/v1/invitations", headers=bob.h).json() == {"invitations": []}


# --- contacts ---


def test_contacts_are_listed_sorted_and_removed_from_both_sides(people):
    alice, bob, carol = people(), people(), people()
    alice.befriend(bob)
    carol.befriend(alice)
    assert alice.client.get("/v1/contacts", headers=alice.h).json() == {"contacts": sorted([bob.id, carol.id])}
    assert alice.client.delete(f"/v1/contacts/{bob.id}", headers=alice.h).status_code == 204
    assert alice.client.get("/v1/contacts", headers=alice.h).json() == {"contacts": [carol.id]}
    assert bob.client.get("/v1/contacts", headers=bob.h).json() == {"contacts": []}
    # Also when they were no contact, and unknown ids.
    assert alice.client.delete(f"/v1/contacts/{bob.id}", headers=alice.h).status_code == 204
    assert alice.client.delete("/v1/contacts/nobody", headers=alice.h).status_code == 204
    assert alice.client.get("/v1/contacts").status_code == 401


def test_confirming_twice_for_the_same_pair_is_harmless(people):
    alice, bob = people(), people()
    alice.befriend(bob)
    iid, _ = alice.invite()
    assert bob.request(iid, alice).status_code == 204
    assert alice.confirm(iid).status_code == 201
    assert alice.client.get("/v1/contacts", headers=alice.h).json() == {"contacts": [bob.id]}


# --- who may read a device list (backlog #18) ---


def test_device_list_access_matrix(people):
    alice, bob, carol, dave, eve = people(), people(), people(), people(), people()
    alice.befriend(bob)                                  # contact
    bob.befriend(carol)
    # Bob and Carol share a file; Alice and Carol are no contacts.
    upload_shared = upload(bob.client, bob.h, 0, keys={bob.phone.id: b64u(b"k"), carol.phone.id: b64u(b"k")},
                           file_id=b64u(os.urandom(16)), members=[bob.id, carol.id])
    assert upload_shared.status_code == 200, upload_shared.text
    iid, _ = dave.invite()                               # holds an open invitation of Dave

    get = lambda who, target, **params: who.client.get(f"/v1/identities/{target.id}", params=params, headers=who.h)
    assert get(alice, alice).status_code == 200                              # self
    r = get(alice, bob)                                                      # contact
    assert r.status_code == 200 and r.json()["entries"] == bob.identity.entries
    assert get(bob, alice).status_code == 200                                # symmetric
    assert get(carol, bob).status_code == 200                                # co-member
    assert get(bob, carol).status_code == 200
    assert get(eve, dave, invitation=iid).status_code == 200                 # open invitation, no request yet
    assert get(eve, dave).status_code == 404                                 # stranger
    assert get(alice, carol).status_code == 404                              # contact of a contact
    assert get(eve, alice).status_code == 404
    assert get(eve, alice, invitation=iid).status_code == 404                # an invitation of somebody else
    assert get(eve, dave, invitation=b64u(os.urandom(16))).status_code == 404
    unknown = eve.client.get(f"/v1/identities/{b64u(os.urandom(16))}", headers=eve.h)
    assert unknown.status_code == 404 and unknown.json() == get(eve, dave).json()   # same answer as for a stranger
    assert eve.client.get(f"/v1/identities/{dave.id}").status_code == 401


def test_invitation_access_lasts_while_the_invitation_lives(people):
    alice, bob = people(), people()
    iid, _ = alice.invite()
    assert bob.request(iid, alice).status_code == 204
    assert bob.identity_status(alice.id, iid) == 200           # requested, still waiting
    alice.client.delete(f"/v1/invitations/{iid}", headers=alice.h)
    assert bob.identity_status(alice.id, iid) == 404           # declined
    iid, _ = alice.invite()
    expire(iid)
    assert bob.identity_status(alice.id, iid) == 404           # expired


def test_removing_a_contact_closes_the_access(people):
    alice, bob = people(), people()
    alice.befriend(bob)
    alice.client.delete(f"/v1/contacts/{bob.id}", headers=alice.h)
    assert bob.identity_status(alice.id) == 404
    assert alice.identity_status(bob.id) == 404
