"""Stateless challenges and bearer tokens, both MACed with the server secret."""

import hashlib
import hmac
import json
import os
import time

from .protocol import ProtocolError, b64u, canonical, from_b64u

CHALLENGE_SECONDS = 120
TOKEN_SECONDS = 3600


def _mac(secret: bytes, purpose: bytes, data: bytes) -> bytes:
    return hmac.new(secret, purpose + data, hashlib.sha256).digest()


def new_challenge(secret: bytes, now: float | None = None) -> str:
    body = int(now or time.time()).to_bytes(8, "big") + os.urandom(16)
    return b64u(body + _mac(secret, b"challenge", body)[:16])


def check_challenge(secret: bytes, challenge: str, now: float | None = None) -> None:
    raw = from_b64u(challenge, 40)
    body, mac = raw[:24], raw[24:]
    if not hmac.compare_digest(mac, _mac(secret, b"challenge", body)[:16]):
        raise ProtocolError("invalid challenge")
    age = (now or time.time()) - int.from_bytes(body[:8], "big")
    if not -5 <= age <= CHALLENGE_SECONDS:
        raise ProtocolError("challenge expired")


def auth_message(server: str, identity: str, device: str, challenge: str) -> bytes:
    """What a device signs to sign in: the server (the host the app calls it at), the identity, the device and the
    challenge, so a server the device talked to can't pass on another server's challenge and sign in there
    (security review H1)."""
    return canonical({"label": "notedown-auth-v2", "server": server, "identity": identity, "device": device,
                      "challenge": challenge})


def delete_message(server: str, identity: str, challenge: str) -> bytes:
    """What the identity key signs to delete its identity (never the same bytes as a sign-in)."""
    return canonical({"label": "notedown-delete-v2", "server": server, "identity": identity, "challenge": challenge})


def server_host(host_header: str | None) -> str:
    """This server as a signature names it: the host of the request (the deployment answers only its own host
    names, docs/server-api.md → "Authentication")."""
    return (host_header or "").strip().lower()


def new_token(secret: bytes, identity: str, device: str, now: float | None = None) -> tuple[str, int]:
    expires = int(now or time.time()) + TOKEN_SECONDS
    payload = canonical({"d": device, "exp": expires, "i": identity})
    return f"{b64u(payload)}.{b64u(_mac(secret, b'token', payload))}", expires


def read_token(secret: bytes, token: str, now: float | None = None) -> tuple[str, str] | None:
    """(identity, device) of a valid token, else None."""
    try:
        payload_part, mac_part = token.split(".")
        payload = from_b64u(payload_part)
        if not hmac.compare_digest(from_b64u(mac_part), _mac(secret, b"token", payload)):
            return None
        claims = json.loads(payload)
    except (ValueError, ProtocolError):
        return None
    if claims["exp"] < (now or time.time()):
        return None
    return claims["i"], claims["d"]
