"""The TRMNL plugin's endpoints (backlog #49, docs/server-api.md → "TRMNL plugin"): TRMNL's install flow, the plugin's
settings page and the screen markup TRMNL asks for. Each installation is a NoteDown identity of its own (client.py);
its secret is stored sealed with a key from the server's secret (docs/sync-and-sharing.md → "TRMNL"). TRMNL's access
token identifies the installation on TRMNL's requests, TRMNL's signed token (JWT) the user on the settings page. Off
unless the operator configures it (TrmnlSettings.from_env)."""

import hashlib
import hmac
import html
import json
import logging
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Annotated, Any, Callable
from urllib.parse import parse_qs, urlencode, urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import jwt
import segno
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import Body, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from starlette.concurrency import run_in_threadpool

from ..protocol import MIN_CLIENT, ProtocolError, b64u, from_b64u
from .client import Client, ClientError, Keys, hkdf, invitation_id, invitation_link
from .notes import parse
from .render import LAYOUTS, render

log = logging.getLogger(__name__)

SESSION_MINUTES = 60   # how long the settings page stays open after TRMNL opened it
# TRMNL's Cloudflare refuses Python's default User-Agent (error 1010), so every request to TRMNL names the plugin.
USER_AGENT = {"User-Agent": "NoteDown-TRMNL-Plugin"}
LAYOUT_KEYS = {"full": "markup", "half_horizontal": "markup_half_horizontal",
               "half_vertical": "markup_half_vertical", "quadrant": "markup_quadrant"}


@dataclass
class TrmnlSettings:
    client_id: str                      # TRMNL's ID for the plugin, the audience of its management-page token
    web_app: str                        # the web app's address, where invitation links point
    server: str = "https://trmnl.com"   # TRMNL's address: its token endpoint and the callback's host
    api: str = "http://127.0.0.1:8080"  # how the plugin reaches this server's API (in the same container)
    # Tests replace these: send(method, path, body, headers) → (status, json), exchange(code) → access token, and
    # jwt_key(token) → the public key TRMNL signed the settings page's token with.
    send: Callable | None = None
    exchange: Callable[[str], str] | None = None
    jwt_key: Callable[[str], Any] | None = None

    @classmethod
    def from_env(cls) -> "TrmnlSettings | None":
        values = [os.environ.get(k, "").strip() for k in ("TRMNL_CLIENT_ID", "WEB_APP_URL")]
        if not all(values):
            return None
        return cls(*values, server=os.environ.get("TRMNL_SERVER", "").strip() or cls.server,
                   api=f"http://127.0.0.1:{os.environ.get('PORT', '8080')}")


@dataclass
class Installation:
    id: str
    identity: str
    sealed: str
    invitation: int
    contact: str | None
    file_id: str | None
    time_zone: str | None
    locale: str | None

    COLUMNS = "id, identity, sealed, invitation, contact, file_id, time_zone, locale"


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def seal(key: bytes, secret: bytes, installation: str) -> str:
    nonce = os.urandom(12)
    return b64u(nonce + AESGCM(key).encrypt(nonce, secret, f"notedown-trmnl:{installation}".encode()))


def unseal(key: bytes, sealed: str, installation: str) -> bytes | None:
    data = from_b64u(sealed)
    try:
        return AESGCM(key).decrypt(data[:12], data[12:], f"notedown-trmnl:{installation}".encode())
    except Exception:
        return None


def bearer(authorization: str | None) -> str:
    token = authorization.removeprefix("Bearer ").strip() if authorization else ""
    if not token:
        raise HTTPException(401, "missing token")
    return token


def http_send(base: str, ip: str) -> Callable:
    """Requests to this server's own API, as the app sends them; `ip` is the user's address, so the per-IP limits
    count the user and not the plugin."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def send(method: str, path: str, body: Any, headers: dict) -> tuple[int, Any]:
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(base + path, data=data, method=method, headers={
            **headers, "Content-Type": "application/json", "NoteDown-Client": str(MIN_CLIENT), "X-Forwarded-For": ip})
        try:
            with opener.open(request, timeout=20) as response:
                return response.status, json.loads(response.read() or b"null")
        except urllib.error.HTTPError as error:
            try:
                return error.code, json.loads(error.read() or b"null")
            except ValueError:
                return error.code, None

    return send


def register_trmnl(app: FastAPI, pool, config: TrmnlSettings, client_ip: Callable, server_secret: bytes) -> None:
    """Adds the /trmnl routes."""
    seal_key = hkdf(server_secret, b"NoteDown", b"trmnl-seal")
    session_key = hkdf(server_secret, b"NoteDown", b"trmnl-session")
    jwks = jwt.PyJWKClient(f"{config.server.rstrip('/')}/.well-known/jwks.json", lifespan=3600, timeout=10,
                           headers=USER_AGENT)

    def client(keys: Keys, request: Request) -> Client:
        return Client(config.send or http_send(config.api, client_ip(request)), keys)

    def load(where: str, value: str) -> Installation | None:
        with pool.connection() as conn:
            row = conn.execute(f"SELECT {Installation.COLUMNS} FROM trmnl_installations WHERE {where} = %s",
                               (value,)).fetchone()
        return Installation(*row) if row else None

    def update(installation: str, **values) -> None:
        sets = ", ".join(f"{k} = %({k})s" for k in values)
        with pool.connection() as conn:
            conn.execute(f"UPDATE trmnl_installations SET {sets} WHERE id = %(id)s", {**values, "id": installation})

    def exchange(code: str) -> str:
        if config.exchange:
            return config.exchange(code)
        # TRMNL knows the plugin by its registered addresses: the code alone, no client credentials.
        request = urllib.request.Request(
            f"{config.server.rstrip('/')}/oauth/token", data=urlencode({"code": code}).encode(), method="POST",
            headers={**USER_AGENT, "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                answer = json.loads(response.read())
        except (urllib.error.URLError, ValueError) as error:
            log.warning("TRMNL token exchange failed: %s", error)
            answer = {}
        answer = answer if isinstance(answer, dict) else {}
        token = answer.get("access_token")
        if not isinstance(token, str) or not token:
            # a wrong code comes back as status 200 with {"error": true, "message": ...}
            log.warning("TRMNL handed out no access token: %s", answer.get("message"))
            raise HTTPException(502, "TRMNL didn't hand out an access token")
        return token

    def connect(inst: Installation, keys: Keys, request: Request) -> Client:
        """Signs in and confirms the request on the current invitation, if one waits (only until the first)."""
        c = client(keys, request)
        c.sign_in()
        if not inst.contact:
            contact = c.answer_requests(invitation_id(keys.invitation_secret(inst.invitation)))
            if contact:
                update(inst.id, contact=contact)
                inst.contact = contact
        return c

    def circles(c: Client) -> list[dict]:
        """The files shared with the plugin, newest change first, each with its text (None: can't be read yet)."""
        out = []
        for f in sorted(c.files(), key=lambda f: f["updated"], reverse=True):
            try:
                text = c.read_file(f["id"], f["members"])
            except (ClientError, ProtocolError, ValueError) as error:
                log.info("TRMNL: file %s not readable: %s", f["id"], error)
                text = None
            out.append({**f, "text": text})
        return out

    def circle_name(c: Client, members: list[str], text: str | None) -> str:
        names = parse(text).members if text else {}
        others = [names.get(m) or "?" for m in members if m != c.keys.identity]
        return " & ".join(others) or "NoteDown"

    # --- TRMNL's install flow ---

    @app.get("/trmnl/install")
    def install(request: Request, code: str, installation_callback_url: str):
        callback = urlparse(installation_callback_url)
        if callback.scheme != "https" or callback.hostname != urlparse(config.server).hostname:
            raise HTTPException(400, "unexpected callback address")
        token = exchange(code)
        if load("token_hash", token_hash(token)) is None:
            keys, installation = Keys.new(), b64u(os.urandom(16))
            c = client(keys, request)
            c.register()
            c.sign_in()
            c.invite(1)
            with pool.connection() as conn:
                conn.execute(
                    "INSERT INTO trmnl_installations (id, token_hash, identity, sealed) "
                    "VALUES (%s, %s, %s, %s) ON CONFLICT (token_hash) DO NOTHING",
                    (installation, token_hash(token), keys.identity, seal(seal_key, keys.secret, installation)))
        return RedirectResponse(installation_callback_url, status_code=302)

    @app.post("/trmnl/installed")
    def installed(authorization: Annotated[str | None, Header()] = None, body: Annotated[dict, Body()] = None):
        user = (body or {}).get("user") or {}
        inst = load("token_hash", token_hash(bearer(authorization)))
        if inst is None:
            raise HTTPException(404, "unknown installation")
        uuid, tz, locale = (str(user.get(k) or "")[:100] or None for k in ("uuid", "time_zone_iana", "locale"))
        update(inst.id, user_uuid=uuid, time_zone=tz, locale=locale)
        return {"success": True}

    @app.post("/trmnl/uninstalled")
    def uninstalled(request: Request, authorization: Annotated[str | None, Header()] = None):
        token = bearer(authorization)
        inst = load("token_hash", token_hash(token))
        if inst is None:
            return {"success": True}   # an error might keep TRMNL from finishing the uninstall
        secret = unseal(seal_key, inst.sealed, inst.id)
        if secret:
            try:
                client(Keys(secret), request).delete()
            except ClientError as error:
                log.warning("TRMNL: deleting identity %s failed: %s", inst.identity, error)
        with pool.connection() as conn:
            conn.execute("DELETE FROM trmnl_installations WHERE id = %s", (inst.id,))
        return {"success": True}

    # --- the screen ---

    @app.post("/trmnl/markup")
    def markup(request: Request, authorization: Annotated[str | None, Header()] = None):
        token = bearer(authorization)
        inst = load("token_hash", token_hash(token))
        if inst is None:
            raise HTTPException(401, "unknown installation")
        lang = "de" if (inst.locale or "").lower().startswith("de") else "en"
        try:
            now = datetime.now(ZoneInfo(inst.time_zone or "UTC"))
        except (ZoneInfoNotFoundError, ValueError):
            now = datetime.now(timezone.utc)
        secret = unseal(seal_key, inst.sealed, inst.id)
        if secret is None:   # the server's secret changed
            return screens(now, lang, message="reconnect")
        try:
            c = connect(inst, Keys(secret), request)
            if not inst.contact:
                return screens(now, lang, message="connect")
            files = sorted(c.files(), key=lambda f: f["updated"], reverse=True)
            chosen = next((f for f in files if f["id"] == inst.file_id), files[0] if files else None)
            if chosen is None:
                return screens(now, lang, circle="NoteDown")
            text = c.read_file(chosen["id"], chosen["members"])
        except (ClientError, ProtocolError, ValueError) as error:
            # TRMNL keeps showing the last picture; the next refresh tries again.
            log.warning("TRMNL: no screen for installation %s: %s", inst.id, error)
            raise HTTPException(503, "notes not available right now")
        return screens(now, lang, text=text, circle=circle_name(c, chosen["members"], text))

    def screens(now: datetime, lang: str, text: str = "", circle: str = "NoteDown", message: str | None = None):
        notes_file = parse(text)
        return JSONResponse({LAYOUT_KEYS[layout]: render(notes_file, circle=circle, now=now, layout=layout,
                                                          lang=lang, message=message) for layout in LAYOUTS})

    # --- the settings page ---

    def trmnl_user(token: str) -> str | None:
        """The user uuid TRMNL signed the settings page's token for (RS256, TRMNL's published keys, for this plugin's
        client ID, valid for two minutes); None when it doesn't check out."""
        try:
            key = config.jwt_key(token) if config.jwt_key else jwks.get_signing_key_from_jwt(token).key
            claims = jwt.decode(token, key, algorithms=["RS256"], audience=config.client_id, leeway=30,
                                options={"require": ["exp", "sub", "aud"]})
        except jwt.PyJWTError as error:
            log.info("TRMNL: settings token refused: %s", error)
            return None
        return claims["sub"] if isinstance(claims["sub"], str) else None

    def session_mac(value: str) -> str:
        return b64u(hmac.new(session_key, value.encode(), hashlib.sha256).digest())

    def session_user(request: Request) -> str | None:
        """The uuid of the settings session this browser holds, if it is still valid."""
        uuid, _, rest = request.cookies.get("trmnl_session", "").rpartition("|")
        expires, _, mac = rest.partition(".")
        if not uuid or not hmac.compare_digest(mac, session_mac(f"{uuid}|{expires}")):
            return None
        return uuid if expires.isdigit() and int(expires) > time.time() else None

    @app.get("/trmnl/manage", response_class=HTMLResponse)
    def manage(request: Request, uuid: str = "", token: Annotated[str, Query(alias="jwt")] = ""):
        inst = load("user_uuid", uuid) if uuid else None
        texts = PAGE["de" if inst and (inst.locale or "").lower().startswith("de") else "en"]
        if inst is None:
            return page(texts, f"<p>{texts['unknown']}</p>", status=404)
        if token:
            # TRMNL's link: start a session of our own and drop the token from the address
            if trmnl_user(token) != uuid:
                return page(texts, f"<p>{texts['expired']}</p>", status=403)
            value = f"{uuid}|{int(time.time()) + SESSION_MINUTES * 60}"
            response = RedirectResponse(f"/trmnl/manage?{urlencode({'uuid': uuid})}", status_code=303)
            response.set_cookie("trmnl_session", f"{value}.{session_mac(value)}", max_age=SESSION_MINUTES * 60,
                                path="/trmnl", secure=True, httponly=True, samesite="lax")
            return response
        if session_user(request) != uuid:
            return page(texts, f"<p>{texts['expired']}</p>", status=403)
        secret = unseal(seal_key, inst.sealed, inst.id)
        if secret is None:   # the server's secret changed
            return page(texts, f"<p>{texts['unknown']}</p>", status=404)
        keys = Keys(secret)
        try:
            c = connect(inst, keys, request)
            if not inst.contact:
                return page(texts, invitation_section(c, inst, keys, request, texts))
            return page(texts, files_section(c, inst, texts, uuid))
        except (ClientError, ProtocolError) as error:
            log.warning("TRMNL settings for installation %s failed: %s", inst.id, error)
            return page(texts, f"<p>{texts['unavailable']}</p>", status=503)

    def invitation_section(c: Client, inst: Installation, keys: Keys, request: Request, texts: dict) -> str:
        """The invitation to add the plugin as a contact; a new one when the last expired or was declined."""
        current = invitation_id(keys.invitation_secret(inst.invitation))
        if not any(i["id"] == current and not i["request"] for i in c.invitations()):
            inst.invitation += 1
            c.invite(inst.invitation)
            update(inst.id, invitation=inst.invitation)
        server = f"{request.headers.get('x-forwarded-proto', request.url.scheme)}://{request.url.netloc}"
        link = invitation_link(config.web_app, keys.identity, keys.invitation_secret(inst.invitation), server)
        qr = segno.make(link, error="m").svg_inline(scale=4, dark="#000", light="#fff")
        esc = html.escape(link)
        return (f"<h2>{texts['connect_title']}</h2><p>{texts['connect_text']}</p>"
                f'<div class="qr">{qr}</div><p><a class="button" href="{esc}">{texts["open_link"]}</a></p>'
                f'<p class="link"><code>{esc}</code></p><p class="hint">{texts["connect_hint"]}</p>')

    def files_section(c: Client, inst: Installation, texts: dict, uuid: str) -> str:
        options = [("", texts["newest"], inst.file_id is None)]
        for f in circles(c):
            name = circle_name(c, f["members"], f["text"]) if f["text"] is not None else texts["not_readable"]
            options.append((f["id"], name, f["id"] == inst.file_id))
        radios = "".join(
            f'<label class="option"><input type="radio" name="file" value="{html.escape(v)}"{" checked" if on else ""}>'
            f"<span>{html.escape(label)}</span></label>" for v, label, on in options)
        empty = f"<p class=hint>{texts['no_files']}</p>" if len(options) == 1 else ""
        return (f"<h2>{texts['files_title']}</h2><p>{texts['files_text']}</p>{empty}"
                f'<form method="post" action="/trmnl/manage?{urlencode({"uuid": uuid})}">{radios}'
                f'<button class="button" type="submit">{texts["save"]}</button></form>'
                f'<p class="hint">{texts["plain_hint"]}</p>')

    @app.post("/trmnl/manage")
    async def choose_file(request: Request, uuid: str):
        # The form is read by hand: FastAPI's Form needs python-multipart for one field.
        file = parse_qs((await request.body()).decode(errors="replace")).get("file", [""])[0]

        def save():
            inst = load("user_uuid", uuid)
            # Only in a session TRMNL started (its cookie is SameSite=Lax, so no other site can post this form).
            if inst is None or session_user(request) != uuid:
                raise HTTPException(403, "open the settings from TRMNL")
            update(inst.id, file_id=file[:22] or None)

        await run_in_threadpool(save)
        return RedirectResponse(f"/trmnl/manage?{urlencode({'uuid': uuid})}", status_code=303)


def page(texts: dict, body: str, status: int = 200) -> HTMLResponse:
    return HTMLResponse(status_code=status, content=f"""<!doctype html>
<html lang="{texts['lang']}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>NoteDown for TRMNL</title><style>{PAGE_STYLE}</style></head>
<body><main><h1>NoteDown <span>for TRMNL</span></h1>{body}</main></body></html>""")


PAGE = {
    "en": {
        "lang": "en",
        "unknown": "This installation is unknown. Install the NoteDown plugin in TRMNL again.",
        "expired": "Open these settings from TRMNL: in the plugin's settings, choose Configure.",
        "unavailable": "Your notes can't be reached right now. Try again in a moment.",
        "connect_title": "Add TRMNL as a contact",
        "connect_text": "Scan the code with the phone you use NoteDown on, or open the link where NoteDown runs. "
                        "NoteDown adds the contact TRMNL; it is confirmed at once.",
        "open_link": "Open in NoteDown",
        "connect_hint": "Then share the notes you want on the display with TRMNL, and come back here to choose "
                        "which ones show.",
        "files_title": "What the display shows",
        "files_text": "The notes you share with TRMNL, grouped by who else they are shared with.",
        "newest": "Automatically: the group that changed last",
        "not_readable": "(not readable yet — open NoteDown once)",
        "no_files": "Nothing is shared with TRMNL yet: share a note with the contact TRMNL in NoteDown.",
        "save": "Save",
        "plain_hint": "TRMNL draws the picture in its cloud, so notes shared with TRMNL are not end-to-end "
                      "encrypted. To stop showing a note, stop sharing it with TRMNL in NoteDown.",
    },
    "de": {
        "lang": "de",
        "unknown": "Diese Installation ist unbekannt. Installiere das NoteDown-Plugin in TRMNL erneut.",
        "expired": "Öffne diese Einstellungen aus TRMNL heraus: in den Einstellungen des Plugins über Configure.",
        "unavailable": "Deine Notizen sind gerade nicht erreichbar. Versuch es gleich noch einmal.",
        "connect_title": "TRMNL als Kontakt hinzufügen",
        "connect_text": "Scanne den Code mit dem Handy, auf dem du NoteDown nutzt, oder öffne den Link dort, wo "
                        "NoteDown läuft. NoteDown fügt den Kontakt TRMNL hinzu; er wird sofort bestätigt.",
        "open_link": "In NoteDown öffnen",
        "connect_hint": "Teile dann die Notizen, die das Display zeigen soll, mit TRMNL und wähle hier, welche "
                        "erscheinen.",
        "files_title": "Was das Display zeigt",
        "files_text": "Die Notizen, die du mit TRMNL teilst, nach den Personen, mit denen sie sonst geteilt sind.",
        "newest": "Automatisch: die zuletzt geänderte Gruppe",
        "not_readable": "(noch nicht lesbar – öffne NoteDown einmal)",
        "no_files": "Mit TRMNL ist noch nichts geteilt: Teile in NoteDown eine Notiz mit dem Kontakt TRMNL.",
        "save": "Speichern",
        "plain_hint": "TRMNL zeichnet das Bild in seiner Cloud, mit TRMNL geteilte Notizen sind also nicht "
                      "Ende-zu-Ende-verschlüsselt. Damit eine Notiz verschwindet, teile sie in NoteDown nicht mehr "
                      "mit TRMNL.",
    },
}

PAGE_STYLE = """
:root{--bg:#eff1f5;--card:#fff;--text:#4c4f69;--muted:#6c6f85;--accent:#8839ef;--line:#ccd0da}
@media (prefers-color-scheme:dark){:root{--bg:#1e1e2e;--card:#313244;--text:#cdd6f4;--muted:#a6adc8;
  --accent:#cba6f7;--line:#45475a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,sans-serif}
main{max-width:560px;margin:0 auto;padding:24px 16px}
h1{font-size:24px;margin:0 0 16px}h1 span{color:var(--muted);font-weight:400}
h2{font-size:18px;margin:24px 0 8px}
.qr{background:#fff;border-radius:12px;padding:12px;width:max-content;max-width:100%;margin:16px 0}
.qr svg{display:block;max-width:100%;height:auto}
.link code{word-break:break-all;font-size:12px;color:var(--muted)}
.hint{color:var(--muted);font-size:14px}
.button{display:inline-block;background:var(--accent);color:var(--bg);border:0;border-radius:999px;padding:10px 20px;
  font:inherit;font-weight:600;text-decoration:none;cursor:pointer;margin-top:12px}
.option{display:flex;gap:12px;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:12px;
  padding:12px 14px;margin:8px 0;cursor:pointer}
.option input{accent-color:var(--accent);width:20px;height:20px;flex:none}
"""
