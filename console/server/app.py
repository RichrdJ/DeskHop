#!/usr/bin/env python3
"""
DeskHop Console - self-hosted remote support portal, admin console and API server.

* Serves the web console (static files in ../web)
* Implements the support-app "API server" protocol:
    /api/login, /api/logout, /api/currentUser, /api/login-options
    /api/heartbeat, /api/sysinfo
    /api/ab (legacy address book), /api/ab/personal (404 -> legacy mode)
    /api/users, /api/peers, /api/device-group/accessible
    /api/audit/conn, /api/audit/file, /api/audit/alarm
* Admin JSON API for the console under /console-api/*

Only the Python standard library is used.
"""
import base64
from html import escape as html_escape
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# --------------------------------------------------------------------------
# Configuration (environment)
# --------------------------------------------------------------------------
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(os.path.dirname(__file__), "..", "data"))
WEB_DIR = os.environ.get("WEB_DIR", os.path.join(os.path.dirname(__file__), "..", "web"))
PORT = int(os.environ.get("PORT", "21114"))
APP_NAME = os.environ.get("APP_NAME", "DeskHop")
ADMIN_USER = os.environ.get("ADMIN_USER", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
SRV_HOST = os.environ.get("SERVER_HOST", "")            # public host of the ID/relay server
SRV_RELAY = os.environ.get("SERVER_RELAY", "")          # optional, default host:21117
SRV_API = os.environ.get("SERVER_API", "")              # optional, default PUBLIC_URL
KEY_FILE = os.environ.get("SERVER_KEY_FILE", "/server-data/id_ed25519.pub")
PUBLIC_URL = os.environ.get("PUBLIC_URL", "")              # e.g. https://support.richrdj.nl
INSTALLER_AUTO_UPDATE = os.environ.get("INSTALLER_AUTO_UPDATE", "1") == "1"
GITHUB_REPO = os.environ.get("INSTALLER_GITHUB_REPO", "rustdesk/rustdesk")
TRUST_PROXY = os.environ.get("TRUST_PROXY", "1") == "1"
ONLINE_WINDOW = 45          # seconds since last heartbeat to count as online
TOKEN_TTL = 60 * 60 * 24 * 30

os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, "deskhop.db")

# connection ids per device the console asked to close (picked up by heartbeat)
PENDING_DISCONNECT = {}
PENDING_LOCK = threading.Lock()


def now():
    return int(time.time())


def log(*a):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), *a, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------
# Database
# --------------------------------------------------------------------------
_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  display_name TEXT DEFAULT '',
  email TEXT DEFAULT '',
  note TEXT DEFAULT '',
  password_hash TEXT NOT NULL,
  is_admin INTEGER DEFAULT 0,
  status INTEGER DEFAULT 1,
  created_at INTEGER,
  last_login INTEGER
);
CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,             -- web | client
  device_id TEXT DEFAULT '',
  device_uuid TEXT DEFAULT '',
  device_name TEXT DEFAULT '',
  ip TEXT DEFAULT '',
  created_at INTEGER,
  last_used INTEGER
);
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  color TEXT DEFAULT '#0e8ee9',
  note TEXT DEFAULT '',
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,            -- device ID
  uuid TEXT DEFAULT '',
  alias TEXT DEFAULT '',
  group_id INTEGER,
  note TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',
  hostname TEXT DEFAULT '',
  username TEXT DEFAULT '',
  os TEXT DEFAULT '',
  cpu TEXT DEFAULT '',
  memory TEXT DEFAULT '',
  version TEXT DEFAULT '',
  ip TEXT DEFAULT '',
  conns INTEGER DEFAULT 0,
  last_seen INTEGER,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS address_books (
  user_id INTEGER PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS audit_conn (
  pk INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT,
  conn_id INTEGER,
  session_id TEXT,
  ip TEXT DEFAULT '',
  peer_id TEXT DEFAULT '',
  peer_name TEXT DEFAULT '',
  type INTEGER,
  auth INTEGER,
  started_at INTEGER,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_audit_conn_dev ON audit_conn(device_id, conn_id);
CREATE TABLE IF NOT EXISTS audit_file (
  pk INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT,
  peer_id TEXT,
  type INTEGER,
  path TEXT,
  is_file INTEGER,
  info TEXT,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS audit_alarm (
  pk INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT,
  typ INTEGER,
  info TEXT,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS downloads (
  pk INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
"""


def db():
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = sqlite3.connect(DB_PATH, timeout=15, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        _local.conn = conn
    return conn


def q(sql, args=()):
    return [dict(r) for r in db().execute(sql, args).fetchall()]


def q1(sql, args=()):
    r = db().execute(sql, args).fetchone()
    return dict(r) if r else None


def ex(sql, args=()):
    cur = db().execute(sql, args)
    return cur.lastrowid


def get_setting(key, default=""):
    r = q1("SELECT value FROM settings WHERE key=?", (key,))
    return r["value"] if r else default


def set_setting(key, value):
    ex("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
       (key, value))


def hash_password(pw):
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, 200_000)
    return "pbkdf2$200000$%s$%s" % (salt.hex(), dk.hex())


def check_password(pw, stored):
    try:
        _, it, salt, dk = stored.split("$")
        calc = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), int(it))
        return hmac.compare_digest(calc.hex(), dk)
    except Exception:
        return False


def init_db():
    db().executescript(SCHEMA)
    if not q1("SELECT id FROM users LIMIT 1"):
        pw = ADMIN_PASSWORD or secrets.token_urlsafe(12)
        ex("INSERT INTO users(username,display_name,password_hash,is_admin,status,created_at) VALUES(?,?,?,?,?,?)",
           (ADMIN_USER, "Administrator", hash_password(pw), 1, 1, now()))
        log("=" * 60)
        log("Created initial admin user '%s'" % ADMIN_USER)
        if not ADMIN_PASSWORD:
            log("Generated password: %s   (change it after first login!)" % pw)
        log("=" * 60)
    if not q1("SELECT id FROM groups LIMIT 1"):
        for name, color in (("Werkplekken", "#0e8ee9"), ("Servers", "#7c5cff")):
            ex("INSERT INTO groups(name,color,created_at) VALUES(?,?,?)", (name, color, now()))


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def read_key():
    custom = get_setting("key")
    if custom:
        return custom.strip()
    try:
        with open(KEY_FILE) as f:
            return f.read().strip()
    except Exception:
        return ""


def server_info():
    host = get_setting("host") or SRV_HOST
    relay = get_setting("relay") or SRV_RELAY
    api = get_setting("api") or SRV_API or public_url()
    key = read_key()
    cfg = {"host": host, "relay": relay, "api": api, "key": key}
    # Client "import server config" string: url-safe base64(json), reversed
    raw = json.dumps(cfg, separators=(",", ":")).encode()
    config_string = base64.urlsafe_b64encode(raw).decode()[::-1]
    return {
        "host": host, "relay": relay, "api": api, "key": key,
        "key_source": "setting" if get_setting("key") else ("file" if key else "missing"),
        "config_string": config_string,
        "filename_windows": win_filename(cfg) if host else "",
        "filename_ok": bool(host),
    }


def brand_slug():
    name = APP_NAME
    s = re.sub(r"[^A-Za-z0-9]+", "-", name).strip("-")
    return re.sub(r"-{2,}", "-", s) or "Support"


def win_filename(cfg):
    """Windows client reads its server config from the .exe name: '<anything>--<token>.exe'.

    token = reversed url-safe base64 (no padding) of the config JSON. The parser splits on '--',
    so the token itself must not contain '--'; vary harmless JSON whitespace until it doesn't.
    """
    body = json.dumps(cfg, separators=(",", ":"))
    token = ""
    for pad in range(0, 40):
        candidate = body[:-1] + (" " * pad) + "}"
        token = base64.urlsafe_b64encode(candidate.encode()).decode().rstrip("=")[::-1]
        if "--" not in token and not token.startswith("-") and not token.endswith("-"):
            break
    return "%s--%s.exe" % (brand_slug(), token)


def public_url():
    return (get_setting("public_url") or PUBLIC_URL).rstrip("/")


def is_online(dev):
    return bool(dev.get("last_seen")) and now() - dev["last_seen"] < ONLINE_WINDOW


def device_out(d, groups=None):
    if groups is None:
        groups = {g["id"]: g for g in q("SELECT * FROM groups")}
    g = groups.get(d.get("group_id"))
    try:
        tags = json.loads(d.get("tags") or "[]")
    except Exception:
        tags = []
    return {
        "id": d["id"], "alias": d["alias"] or "", "name": d["alias"] or d["hostname"] or d["id"],
        "hostname": d["hostname"], "username": d["username"], "os": d["os"], "cpu": d["cpu"],
        "memory": d["memory"], "version": d["version"], "ip": d["ip"], "note": d["note"],
        "tags": tags, "group_id": d["group_id"], "group": g["name"] if g else "",
        "group_color": g["color"] if g else "", "online": is_online(d), "conns": d["conns"] or 0,
        "last_seen": d["last_seen"], "created_at": d["created_at"],
    }


def platform_of(os_str):
    s = (os_str or "").lower()
    if "windows" in s:
        return "Windows"
    if "mac" in s or "darwin" in s:
        return "Mac OS"
    if "android" in s:
        return "Android"
    if "ios" in s:
        return "iOS"
    if s:
        return "Linux"
    return ""


def user_payload(u):
    return {
        "name": u["username"], "display_name": u["display_name"] or u["username"],
        "email": u["email"] or "", "note": u["note"] or "", "status": u["status"],
        "is_admin": bool(u["is_admin"]), "avatar": "",
    }


def default_ab():
    return {"tags": [], "peers": [], "tag_colors": "{}"}


class HttpError(Exception):
    def __init__(self, status, msg):
        super().__init__(msg)
        self.status = status
        self.msg = msg


# --------------------------------------------------------------------------
# Request handler
# --------------------------------------------------------------------------
ROUTES = []


def route(method, pattern, auth=None):
    """auth: None (public), 'client', 'web', 'admin'"""
    rx = re.compile("^" + pattern + "$")

    def deco(fn):
        ROUTES.append((method, rx, auth, fn))
        return fn
    return deco


class Handler(BaseHTTPRequestHandler):
    server_version = "DeskHop"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("ACCESS_LOG") == "1":
            log(self.address_string(), fmt % args)

    # ---- plumbing -----------------------------------------------------
    def client_ip(self):
        if TRUST_PROXY:
            fwd = self.headers.get("X-Forwarded-For") or self.headers.get("X-Real-IP")
            if fwd:
                return fwd.split(",")[0].strip()
        return self.client_address[0]

    def body_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return {}
        raw = self.rfile.read(n)
        try:
            v = json.loads(raw.decode("utf-8") or "{}")
            return v if isinstance(v, dict) else {"_": v}
        except Exception:
            return {}

    def send(self, status, body, ctype="application/json"):
        if isinstance(body, (dict, list)) or body is None:
            data = json.dumps(body).encode()
        elif isinstance(body, str):
            data = body.encode()
        else:
            data = body
        self.send_response(status)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith(("text", "application/j")) else ""))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store" if ctype == "application/json" else "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def auth_user(self, kind):
        h = self.headers.get("Authorization", "")
        if not h.startswith("Bearer "):
            return None, None
        tok = h[7:].strip()
        t = q1("SELECT * FROM tokens WHERE token=?", (tok,))
        if not t or (kind == "web" and t["kind"] != "web") or now() - (t["last_used"] or 0) > TOKEN_TTL:
            return None, None
        u = q1("SELECT * FROM users WHERE id=?", (t["user_id"],))
        if not u or u["status"] != 1:
            return None, None
        if now() - (t["last_used"] or 0) > 60:
            ex("UPDATE tokens SET last_used=?, ip=? WHERE token=?", (now(), self.client_ip(), tok))
        return u, t

    def dispatch(self, method):
        url = urlparse(self.path)
        path = url.path.rstrip("/") or "/"
        self.query = {k: v[-1] for k, v in parse_qs(url.query).items()}
        try:
            for m, rx, auth, fn in ROUTES:
                if m != method:
                    continue
                mt = rx.match(path)
                if not mt:
                    continue
                self.user = self.token = None
                if auth:
                    self.user, self.token = self.auth_user("web" if auth in ("web", "admin") else "any")
                    if not self.user:
                        return self.send(401, {"error": "Unauthorized"})
                    if auth == "admin" and not self.user["is_admin"]:
                        return self.send(403, {"error": "Admin required!"})
                res = fn(self, *mt.groups())
                if res is not None and not getattr(self, "_sent", False):
                    if isinstance(res, tuple):
                        self.send(*res)
                    else:
                        self.send(200, res)
                return
            if method in ("GET", "HEAD") and not path.startswith(("/api", "/console-api")):
                return self.static(path)
            self.send(404, {"error": "Not found"})
        except HttpError as e:
            self.send(e.status, {"error": e.msg})
        except Exception as e:
            traceback.print_exc()
            self.send(500, {"error": "Internal error: %s" % e})

    def static(self, path):
        root = os.path.realpath(WEB_DIR)
        if path == "/admin":
            path = "/admin/index.html"
        elif path in ("/", "/index.html"):
            path = "/public/index.html"
        elif not path.startswith(("/admin/", "/public/")) and path != "/favicon.svg":
            path = "/public" + path
        full = os.path.realpath(os.path.join(WEB_DIR, path.lstrip("/")))
        if not full.startswith(root) or not os.path.isfile(full):
            # admin is a hash-routed SPA; everything else falls back to the download page
            sub = "admin" if path.startswith("/admin/") else "public"
            full = os.path.join(root, sub, "index.html")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        with open(full, "rb") as f:
            data = f.read()
        if full.endswith("index.html"):
            data = data.replace(b"__APP_NAME__", html_escape(APP_NAME).encode())
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)
            return
        self.send(200, data, ctype)

    def do_GET(self):
        self.dispatch("GET")

    def do_HEAD(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_PATCH(self):
        self.dispatch("PATCH")

    def do_DELETE(self):
        self.dispatch("DELETE")


# --------------------------------------------------------------------------
# Login throttling
# --------------------------------------------------------------------------
_fails = {}


def throttle(ip):
    rec = _fails.get(ip)
    if rec and rec[0] >= 8 and now() - rec[1] < 300:
        raise HttpError(429, "Te veel mislukte pogingen, probeer het over 5 minuten opnieuw.")


def login_failed(ip):
    rec = _fails.get(ip, [0, 0])
    _fails[ip] = [rec[0] + 1, now()]


def do_login(h, username, password):
    ip = h.client_ip()
    throttle(ip)
    u = q1("SELECT * FROM users WHERE username=?", (username or "",))
    if not u or not check_password(password or "", u["password_hash"]):
        login_failed(ip)
        raise HttpError(401, "Gebruikersnaam of wachtwoord onjuist")
    if u["status"] != 1:
        raise HttpError(403, "Account is uitgeschakeld")
    _fails.pop(ip, None)
    ex("UPDATE users SET last_login=? WHERE id=?", (now(), u["id"]))
    return u


# ==========================================================================
# Support-app client API
# ==========================================================================
@route("GET", "/api/login-options")
def api_login_options(h):
    return []


@route("POST", "/api/login")
def api_login(h):
    b = h.body_json()
    try:
        u = do_login(h, b.get("username"), b.get("password"))
    except HttpError as e:
        return 200, {"error": e.msg}
    tok = secrets.token_hex(32)
    di = b.get("deviceInfo") or {}
    ex("INSERT INTO tokens(token,user_id,kind,device_id,device_uuid,device_name,ip,created_at,last_used) "
       "VALUES(?,?,?,?,?,?,?,?,?)",
       (tok, u["id"], "client", b.get("id", ""), b.get("uuid", ""),
        "%s %s" % (di.get("os", ""), di.get("name", "")), h.client_ip(), now(), now()))
    return {"access_token": tok, "type": "access_token", "user": user_payload(u)}


@route("POST", "/api/currentUser", auth="client")
def api_current_user(h):
    return user_payload(h.user)


@route("POST", "/api/logout")
def api_logout(h):
    a = h.headers.get("Authorization", "")
    if a.startswith("Bearer "):
        ex("DELETE FROM tokens WHERE token=?", (a[7:].strip(),))
    return 200, ""


@route("POST", "/api/heartbeat")
def api_heartbeat(h):
    b = h.body_json()
    did = str(b.get("id") or "").strip()
    if not did:
        return {}
    conns = b.get("conns") or []
    d = q1("SELECT id, uuid, hostname FROM devices WHERE id=?", (did,))
    resp = {}
    if not d:
        ex("INSERT INTO devices(id,uuid,ip,conns,last_seen,created_at,version) VALUES(?,?,?,?,?,?,?)",
           (did, b.get("uuid", ""), h.client_ip(), len(conns), now(), now(), str(b.get("ver", ""))))
        resp["sysinfo"] = True
    else:
        ex("UPDATE devices SET last_seen=?, ip=?, conns=?, uuid=? WHERE id=?",
           (now(), h.client_ip(), len(conns), b.get("uuid", d["uuid"]), did))
        if not d["hostname"]:
            resp["sysinfo"] = True
    # Mark sessions as ended if their conn id is no longer alive
    open_rows = q("SELECT pk, conn_id FROM audit_conn WHERE device_id=? AND ended_at IS NULL", (did,))
    for r in open_rows:
        if r["conn_id"] not in conns:
            ex("UPDATE audit_conn SET ended_at=? WHERE pk=?", (now(), r["pk"]))
    with PENDING_LOCK:
        disc = PENDING_DISCONNECT.pop(did, None)
    if disc:
        resp["disconnect"] = disc
    return resp


@route("POST", "/api/sysinfo")
def api_sysinfo(h):
    b = h.body_json()
    did = str(b.get("id") or "").strip()
    if not did or not q1("SELECT id FROM devices WHERE id=?", (did,)):
        return 200, "ID_NOT_FOUND", "text/plain"
    ex("UPDATE devices SET hostname=?, username=?, os=?, cpu=?, memory=?, version=?, uuid=?, last_seen=? WHERE id=?",
       (b.get("hostname", ""), b.get("username", ""), b.get("os", ""), b.get("cpu", ""),
        b.get("memory", ""), b.get("version", ""), b.get("uuid", ""), now(), did))
    return 200, "SYSINFO_UPDATED", "text/plain"


# --- Address book (legacy mode) ---------------------------------------------
@route("POST", "/api/ab/personal")
def api_ab_personal(h):
    # 404 makes the client use the (simpler) legacy address book protocol
    return 404, {"error": "Not found"}


@route("POST", "/api/ab/settings")
def api_ab_settings(h):
    return 404, {"error": "Not found"}


@route("POST", "/api/ab/shared/profiles")
def api_ab_shared(h):
    return {"total": 0, "data": []}


def load_ab(user_id):
    r = q1("SELECT data FROM address_books WHERE user_id=?", (user_id,))
    if not r:
        return default_ab()
    try:
        return json.loads(r["data"])
    except Exception:
        return default_ab()


def save_ab(user_id, ab):
    ex("INSERT INTO address_books(user_id,data,updated_at) VALUES(?,?,?) "
       "ON CONFLICT(user_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at",
       (user_id, json.dumps(ab), now()))


@route("GET", "/api/ab", auth="client")
def api_ab_get(h):
    return {"data": json.dumps(load_ab(h.user["id"])), "updated_at": now()}


@route("POST", "/api/ab/get", auth="client")
def api_ab_get_post(h):
    return api_ab_get(h)


@route("POST", "/api/ab", auth="client")
def api_ab_post(h):
    b = h.body_json()
    data = b.get("data")
    try:
        ab = json.loads(data) if isinstance(data, str) else (data or default_ab())
        if not isinstance(ab, dict):
            raise ValueError
    except Exception:
        return 400, {"error": "Invalid address book"}
    save_ab(h.user["id"], ab)
    return 200, ""


# --- Groups / accessible devices (shown in client's "Accessible devices") ----
def paged(h, rows):
    cur = max(int(h.query.get("current", 1) or 1), 1)
    size = max(min(int(h.query.get("pageSize", 100) or 100), 500), 1)
    return {"total": len(rows), "data": rows[(cur - 1) * size: cur * size]}


@route("GET", "/api/device-group/accessible", auth="client")
def api_dg_accessible(h):
    return paged(h, [{"name": g["name"]} for g in q("SELECT name FROM groups ORDER BY name")])


@route("GET", "/api/users", auth="client")
def api_users(h):
    rows = q("SELECT * FROM users WHERE status=1 ORDER BY username")
    return paged(h, [user_payload(u) for u in rows])


@route("GET", "/api/peers", auth="client")
def api_peers(h):
    groups = {g["id"]: g for g in q("SELECT * FROM groups")}
    out = []
    for d in q("SELECT * FROM devices ORDER BY COALESCE(NULLIF(alias,''), hostname, id)"):
        g = groups.get(d["group_id"])
        out.append({
            "id": d["id"],
            "info": {"username": d["username"], "os": d["os"], "device_name": d["alias"] or d["hostname"]},
            "status": 1, "user": "", "user_name": "", "note": d["note"] or "",
            "device_group_name": g["name"] if g else "",
        })
    return paged(h, out)


# --- Audit -------------------------------------------------------------------
@route("POST", "/api/audit/conn")
def api_audit_conn(h):
    b = h.body_json()
    did = str(b.get("id") or "")
    cid = b.get("conn_id")
    action = b.get("action")
    row = q1("SELECT * FROM audit_conn WHERE device_id=? AND conn_id=? ORDER BY pk DESC LIMIT 1", (did, cid))
    if action == "new" or not row:
        if action == "close":
            return 200, ""
        ex("INSERT INTO audit_conn(device_id,conn_id,session_id,ip,started_at) VALUES(?,?,?,?,?)",
           (did, cid, str(b.get("session_id", "")), b.get("ip", ""), now()))
        row = q1("SELECT * FROM audit_conn WHERE device_id=? AND conn_id=? ORDER BY pk DESC LIMIT 1", (did, cid))
        if action == "new":
            return 200, ""
    if action == "close":
        ex("UPDATE audit_conn SET ended_at=? WHERE pk=?", (now(), row["pk"]))
    elif b.get("peer") is not None:
        peer = b.get("peer")
        pid, pname = "", ""
        if isinstance(peer, list):
            pid = str(peer[0]) if len(peer) > 0 else ""
            pname = str(peer[1]) if len(peer) > 1 else ""
        elif isinstance(peer, dict):
            pid, pname = str(peer.get("my_id", "")), str(peer.get("my_name", ""))
        ex("UPDATE audit_conn SET peer_id=?, peer_name=?, type=?, auth=? WHERE pk=?",
           (pid, pname, b.get("type"), b.get("primary_auth"), row["pk"]))
    return 200, ""


@route("POST", "/api/audit/file")
def api_audit_file(h):
    b = h.body_json()
    ex("INSERT INTO audit_file(device_id,peer_id,type,path,is_file,info,created_at) VALUES(?,?,?,?,?,?,?)",
       (str(b.get("id", "")), str(b.get("peer_id", "")), b.get("type"), b.get("path", ""),
        1 if b.get("is_file") else 0, b.get("info", "") if isinstance(b.get("info"), str) else json.dumps(b.get("info")),
        now()))
    return 200, ""


@route("POST", "/api/audit/alarm")
def api_audit_alarm(h):
    b = h.body_json()
    ex("INSERT INTO audit_alarm(device_id,typ,info,created_at) VALUES(?,?,?,?)",
       (str(b.get("id", "")), b.get("typ"), json.dumps(b.get("info")), now()))
    return 200, ""


@route("GET", "/api/health")
def api_health(h):
    return {"ok": True, "name": APP_NAME}


# ==========================================================================
# Console API
# ==========================================================================
@route("GET", "/console-api/meta")
def c_meta(h):
    return {"name": APP_NAME}


@route("POST", "/console-api/login")
def c_login(h):
    b = h.body_json()
    u = do_login(h, b.get("username"), b.get("password"))
    tok = secrets.token_hex(32)
    ex("INSERT INTO tokens(token,user_id,kind,ip,created_at,last_used,device_name) VALUES(?,?,?,?,?,?,?)",
       (tok, u["id"], "web", h.client_ip(), now(), now(), (h.headers.get("User-Agent") or "")[:120]))
    return {"token": tok, "user": c_user_out(u)}


@route("POST", "/console-api/logout", auth="web")
def c_logout(h):
    ex("DELETE FROM tokens WHERE token=?", (h.token["token"],))
    return {"ok": True}


def c_user_out(u):
    return {
        "id": u["id"], "username": u["username"], "display_name": u["display_name"] or u["username"],
        "email": u["email"], "note": u["note"], "is_admin": bool(u["is_admin"]), "status": u["status"],
        "created_at": u["created_at"], "last_login": u["last_login"],
    }


@route("GET", "/console-api/me", auth="web")
def c_me(h):
    return c_user_out(h.user)


@route("POST", "/console-api/me/password", auth="web")
def c_me_password(h):
    b = h.body_json()
    if not check_password(b.get("current", ""), h.user["password_hash"]):
        raise HttpError(400, "Huidig wachtwoord klopt niet")
    if len(b.get("new", "")) < 8:
        raise HttpError(400, "Nieuw wachtwoord moet minimaal 8 tekens zijn")
    ex("UPDATE users SET password_hash=? WHERE id=?", (hash_password(b["new"]), h.user["id"]))
    ex("DELETE FROM tokens WHERE user_id=? AND token<>?", (h.user["id"], h.token["token"]))
    return {"ok": True}


@route("GET", "/console-api/stats", auth="web")
def c_stats(h):
    devs = q("SELECT last_seen, os, conns FROM devices")
    online = [d for d in devs if is_online(d)]
    day_ago = now() - 86400
    sess_today = q1("SELECT COUNT(*) c FROM audit_conn WHERE started_at>?", (day_ago,))["c"]
    active = q1("SELECT COUNT(*) c FROM audit_conn WHERE ended_at IS NULL AND started_at>?", (now() - 86400 * 2,))["c"]
    plat = {}
    for d in devs:
        p = platform_of(d["os"]) or "Onbekend"
        plat[p] = plat.get(p, 0) + 1
    # sessions per day, last 14 days
    days = []
    start = now() - 13 * 86400
    rows = q("SELECT started_at FROM audit_conn WHERE started_at>?", (start - 86400,))
    for i in range(14):
        t0 = time.mktime(time.localtime(start + i * 86400)[:3] + (0, 0, 0, 0, 0, -1))
        cnt = sum(1 for r in rows if t0 <= r["started_at"] < t0 + 86400)
        days.append({"day": time.strftime("%Y-%m-%d", time.localtime(t0)), "count": cnt})
    return {
        "devices": len(devs), "online": len(online), "sessions_24h": sess_today, "active_sessions": active,
        "users": q1("SELECT COUNT(*) c FROM users")["c"], "platforms": plat, "sessions_per_day": days,
    }


# ---- devices ----
@route("GET", "/console-api/devices", auth="web")
def c_devices(h):
    groups = {g["id"]: g for g in q("SELECT * FROM groups")}
    return [device_out(d, groups) for d in q("SELECT * FROM devices")]


@route("POST", "/console-api/devices", auth="web")
def c_device_add(h):
    b = h.body_json()
    did = re.sub(r"\s+", "", str(b.get("id", "")))
    if not re.match(r"^[A-Za-z0-9_\-]{3,32}$", did):
        raise HttpError(400, "Ongeldig ID")
    if q1("SELECT id FROM devices WHERE id=?", (did,)):
        raise HttpError(409, "Dit apparaat bestaat al")
    ex("INSERT INTO devices(id,alias,group_id,note,created_at) VALUES(?,?,?,?,?)",
       (did, b.get("alias", ""), b.get("group_id") or None, b.get("note", ""), now()))
    return device_out(q1("SELECT * FROM devices WHERE id=?", (did,)))


@route("PATCH", "/console-api/devices/([^/]+)", auth="web")
def c_device_patch(h, did):
    d = q1("SELECT * FROM devices WHERE id=?", (did,))
    if not d:
        raise HttpError(404, "Apparaat niet gevonden")
    b = h.body_json()
    fields = {}
    for k in ("alias", "note"):
        if k in b:
            fields[k] = str(b[k] or "")
    if "group_id" in b:
        fields["group_id"] = b["group_id"] or None
    if "tags" in b:
        fields["tags"] = json.dumps([str(t) for t in (b["tags"] or [])])
    if fields:
        ex("UPDATE devices SET %s WHERE id=?" % ",".join("%s=?" % k for k in fields), (*fields.values(), did))
    return device_out(q1("SELECT * FROM devices WHERE id=?", (did,)))


@route("DELETE", "/console-api/devices/([^/]+)", auth="admin")
def c_device_delete(h, did):
    ex("DELETE FROM devices WHERE id=?", (did,))
    return {"ok": True}


# ---- groups ----
@route("GET", "/console-api/groups", auth="web")
def c_groups(h):
    return q("SELECT g.*, (SELECT COUNT(*) FROM devices d WHERE d.group_id=g.id) AS device_count "
             "FROM groups g ORDER BY g.name")


@route("POST", "/console-api/groups", auth="web")
def c_group_add(h):
    b = h.body_json()
    name = str(b.get("name", "")).strip()
    if not name:
        raise HttpError(400, "Naam is verplicht")
    if q1("SELECT id FROM groups WHERE name=?", (name,)):
        raise HttpError(409, "Groep bestaat al")
    gid = ex("INSERT INTO groups(name,color,note,created_at) VALUES(?,?,?,?)",
             (name, b.get("color") or "#0e8ee9", b.get("note", ""), now()))
    return q1("SELECT * FROM groups WHERE id=?", (gid,))


@route("PATCH", "/console-api/groups/(\\d+)", auth="web")
def c_group_patch(h, gid):
    b = h.body_json()
    for k in ("name", "color", "note"):
        if k in b:
            ex("UPDATE groups SET %s=? WHERE id=?" % k, (str(b[k]), int(gid)))
    return q1("SELECT * FROM groups WHERE id=?", (int(gid),))


@route("DELETE", "/console-api/groups/(\\d+)", auth="web")
def c_group_delete(h, gid):
    ex("UPDATE devices SET group_id=NULL WHERE group_id=?", (int(gid),))
    ex("DELETE FROM groups WHERE id=?", (int(gid),))
    return {"ok": True}


# ---- sessions / audit ----
TYPE_NAMES = {0: "Remote control", 1: "Bestandsoverdracht", 2: "Port forward", 3: "Camera", 4: "Terminal"}


@route("GET", "/console-api/sessions", auth="web")
def c_sessions(h):
    limit = min(int(h.query.get("limit", 200) or 200), 2000)
    devs = {d["id"]: d for d in q("SELECT id, alias, hostname FROM devices")}
    out = []
    for r in q("SELECT * FROM audit_conn ORDER BY pk DESC LIMIT ?", (limit,)):
        d = devs.get(r["device_id"]) or {}
        r["device_name"] = d.get("alias") or d.get("hostname") or ""
        r["type_name"] = TYPE_NAMES.get(r["type"], "Verbinding")
        r["active"] = r["ended_at"] is None and now() - (r["started_at"] or 0) < 86400 * 2
        out.append(r)
    return out


@route("POST", "/console-api/sessions/(\\d+)/disconnect", auth="web")
def c_session_disconnect(h, pk):
    r = q1("SELECT * FROM audit_conn WHERE pk=?", (int(pk),))
    if not r:
        raise HttpError(404, "Sessie niet gevonden")
    with PENDING_LOCK:
        PENDING_DISCONNECT.setdefault(r["device_id"], []).append(r["conn_id"])
    return {"ok": True, "message": "Verbreken aangevraagd; wordt uitgevoerd bij de volgende heartbeat (≤15s)."}


@route("GET", "/console-api/files", auth="web")
def c_files(h):
    return q("SELECT * FROM audit_file ORDER BY pk DESC LIMIT 500")


# ---- users ----
@route("GET", "/console-api/users", auth="admin")
def c_users(h):
    out = []
    for u in q("SELECT * FROM users ORDER BY username"):
        o = c_user_out(u)
        o["clients"] = q1("SELECT COUNT(*) c FROM tokens WHERE user_id=? AND kind='client'", (u["id"],))["c"]
        ab = load_ab(u["id"])
        o["ab_peers"] = len(ab.get("peers", []))
        out.append(o)
    return out


@route("POST", "/console-api/users", auth="admin")
def c_user_add(h):
    b = h.body_json()
    un = str(b.get("username", "")).strip()
    if not re.match(r"^[A-Za-z0-9_.@\-]{2,64}$", un):
        raise HttpError(400, "Ongeldige gebruikersnaam")
    if len(b.get("password", "")) < 8:
        raise HttpError(400, "Wachtwoord moet minimaal 8 tekens zijn")
    if q1("SELECT id FROM users WHERE username=?", (un,)):
        raise HttpError(409, "Gebruiker bestaat al")
    uid = ex("INSERT INTO users(username,display_name,email,note,password_hash,is_admin,status,created_at) "
             "VALUES(?,?,?,?,?,?,?,?)",
             (un, b.get("display_name", ""), b.get("email", ""), b.get("note", ""),
              hash_password(b["password"]), 1 if b.get("is_admin") else 0, 1, now()))
    return c_user_out(q1("SELECT * FROM users WHERE id=?", (uid,)))


@route("PATCH", "/console-api/users/(\\d+)", auth="admin")
def c_user_patch(h, uid):
    uid = int(uid)
    u = q1("SELECT * FROM users WHERE id=?", (uid,))
    if not u:
        raise HttpError(404, "Gebruiker niet gevonden")
    b = h.body_json()
    if uid == h.user["id"] and (b.get("is_admin") is False or b.get("status") == 0):
        raise HttpError(400, "Je kunt jezelf niet degraderen of uitschakelen")
    for k in ("display_name", "email", "note"):
        if k in b:
            ex("UPDATE users SET %s=? WHERE id=?" % k, (str(b[k] or ""), uid))
    if "is_admin" in b:
        ex("UPDATE users SET is_admin=? WHERE id=?", (1 if b["is_admin"] else 0, uid))
    if "status" in b:
        ex("UPDATE users SET status=? WHERE id=?", (1 if b["status"] else 0, uid))
        if not b["status"]:
            ex("DELETE FROM tokens WHERE user_id=?", (uid,))
    if b.get("password"):
        if len(b["password"]) < 8:
            raise HttpError(400, "Wachtwoord moet minimaal 8 tekens zijn")
        ex("UPDATE users SET password_hash=? WHERE id=?", (hash_password(b["password"]), uid))
        ex("DELETE FROM tokens WHERE user_id=?", (uid,))
    return c_user_out(q1("SELECT * FROM users WHERE id=?", (uid,)))


@route("DELETE", "/console-api/users/(\\d+)", auth="admin")
def c_user_delete(h, uid):
    if int(uid) == h.user["id"]:
        raise HttpError(400, "Je kunt jezelf niet verwijderen")
    ex("DELETE FROM tokens WHERE user_id=?", (int(uid),))
    ex("DELETE FROM address_books WHERE user_id=?", (int(uid),))
    ex("DELETE FROM users WHERE id=?", (int(uid),))
    return {"ok": True}


@route("POST", "/console-api/users/(\\d+)/sync-ab", auth="admin")
def c_user_sync_ab(h, uid):
    """Merge all managed devices into the user's address book (group = tag)."""
    uid = int(uid)
    if not q1("SELECT id FROM users WHERE id=?", (uid,)):
        raise HttpError(404, "Gebruiker niet gevonden")
    ab = load_ab(uid)
    peers = {p.get("id"): p for p in ab.get("peers", []) if isinstance(p, dict)}
    tags = list(ab.get("tags", []))
    try:
        colors = json.loads(ab.get("tag_colors") or "{}")
    except Exception:
        colors = {}
    groups = {g["id"]: g for g in q("SELECT * FROM groups")}
    added = 0
    for d in q("SELECT * FROM devices"):
        g = groups.get(d["group_id"])
        p = peers.get(d["id"])
        if not p:
            p = {"id": d["id"], "tags": []}
            peers[d["id"]] = p
            added += 1
        p["alias"] = d["alias"] or p.get("alias", "")
        p["hostname"] = d["hostname"] or p.get("hostname", "")
        p["username"] = d["username"] or p.get("username", "")
        p["platform"] = platform_of(d["os"]) or p.get("platform", "")
        if g:
            if g["name"] not in tags:
                tags.append(g["name"])
            c = g["color"].lstrip("#")
            try:
                colors[g["name"]] = int("ff" + c, 16)
            except ValueError:
                pass
            if g["name"] not in p.setdefault("tags", []):
                p["tags"].append(g["name"])
    ab = {"tags": tags, "peers": list(peers.values()), "tag_colors": json.dumps(colors)}
    save_ab(uid, ab)
    return {"ok": True, "added": added, "total": len(peers)}


# ---- tokens / client logins ----
@route("GET", "/console-api/tokens", auth="admin")
def c_tokens(h):
    return q("SELECT substr(t.token,1,8) AS token_prefix, t.kind, t.device_id, t.device_name, t.ip, "
             "t.created_at, t.last_used, u.username FROM tokens t JOIN users u ON u.id=t.user_id "
             "ORDER BY t.last_used DESC LIMIT 300")


# ---- deploy / settings ----
@route("GET", "/console-api/deploy", auth="web")
def c_deploy(h):
    return dict(server_info(), public_url=public_url())


@route("GET", "/console-api/settings", auth="admin")
def c_settings_get(h):
    return {
        "host": get_setting("host"), "relay": get_setting("relay"), "api": get_setting("api"),
        "key": get_setting("key"),
        "env": {"host": SRV_HOST, "relay": SRV_RELAY, "api": SRV_API, "key_file": KEY_FILE},
    }


@route("PUT", "/console-api/settings", auth="admin")
def c_settings_put(h):
    b = h.body_json()
    for k in ("host", "relay", "api", "key"):
        if k in b:
            set_setting(k, str(b[k] or "").strip())
    return c_settings_get(h)


# ==========================================================================
# Installers / public download portal
# ==========================================================================
INSTALLER_DIR = os.path.join(DATA_DIR, "installers")
PLATFORMS = [
    # key, label, os, arch-label, regex on GitHub asset name, enabled by default
    ("win_exe", "Windows", "windows", "64-bit · .exe, direct te starten", r"^[a-z]+-[\d.]+-x86_64\.exe$", True),
    ("win_msi", "Windows MSI", "windows", "64-bit · .msi, voor uitrol", r"^[a-z]+-[\d.]+-x86_64\.msi$", True),
    ("mac_arm", "macOS Apple Silicon", "mac", "M-chip · .dmg", r"^[a-z]+-[\d.]+-aarch64\.dmg$", True),
    ("mac_x64", "macOS Intel", "mac", "Intel · .dmg", r"^[a-z]+-[\d.]+-x86_64\.dmg$", True),
]
PLATFORM_MAP = {p[0]: p for p in PLATFORMS}
SYNC_STATE = {"running": False, "last_error": "", "last_run": 0, "progress": ""}
SYNC_LOCK = threading.Lock()


def inst_meta():
    try:
        return json.loads(get_setting("installers") or "{}")
    except Exception:
        return {}


def inst_meta_save(m):
    set_setting("installers", json.dumps(m))


def inst_enabled(key, meta=None):
    meta = meta if meta is not None else inst_meta()
    e = meta.get(key, {}).get("enabled")
    return PLATFORM_MAP[key][5] if e is None else bool(e)


def inst_file(key, meta=None):
    """Path of the file to serve for a platform (uploaded file wins over GitHub cache)."""
    meta = meta if meta is not None else inst_meta()
    m = meta.get(key, {})
    for src in ("upload", "github"):
        f = m.get(src, {}).get("file")
        if f:
            p = os.path.join(INSTALLER_DIR, key, src, f)
            if os.path.isfile(p):
                return p, src, m[src]
    return None, None, None


def http_get_json(url):
    import urllib.request
    req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "deskhop-console"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def sync_installers(force=False):
    """Download the latest upstream release assets for enabled platforms into the cache."""
    import urllib.request
    if not SYNC_LOCK.acquire(blocking=False):
        return
    SYNC_STATE.update(running=True, last_error="", progress="Release-informatie ophalen…")
    try:
        pinned = get_setting("installer_version")
        url = "https://api.github.com/repos/%s/releases/%s" % (
            GITHUB_REPO, ("tags/" + pinned) if pinned else "latest")
        rel = http_get_json(url)
        version = rel.get("tag_name", "")
        meta = inst_meta()
        for key, label, _os, _arch, rx, _d in PLATFORMS:
            if not inst_enabled(key, meta):
                continue
            asset = next((a for a in rel.get("assets", []) if re.match(rx, a["name"])), None)
            if not asset:
                continue
            gh = meta.setdefault(key, {}).get("github", {})
            target_dir = os.path.join(INSTALLER_DIR, key, "github")
            if not force and gh.get("version") == version and os.path.isfile(os.path.join(target_dir, gh.get("file", ""))):
                continue
            SYNC_STATE["progress"] = "%s downloaden (%s, %.0f MB)…" % (label, version, asset["size"] / 1e6)
            os.makedirs(target_dir, exist_ok=True)
            tmp = os.path.join(target_dir, ".download")
            h = hashlib.sha256()
            req = urllib.request.Request(asset["browser_download_url"], headers={"User-Agent": "deskhop-console"})
            with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as f:
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    h.update(chunk)
                    f.write(chunk)
            for old in os.listdir(target_dir):
                if old != ".download":
                    os.remove(os.path.join(target_dir, old))
            os.replace(tmp, os.path.join(target_dir, asset["name"]))
            meta = inst_meta()
            meta.setdefault(key, {})["github"] = {
                "file": asset["name"], "version": version, "size": asset["size"],
                "sha256": h.hexdigest(), "updated_at": now(),
            }
            inst_meta_save(meta)
            log("Installer cached: %s %s" % (key, asset["name"]))
        set_setting("installer_latest", version)
        SYNC_STATE["progress"] = "Bijgewerkt naar %s" % version
    except Exception as e:
        SYNC_STATE["last_error"] = str(e)
        SYNC_STATE["progress"] = ""
        log("Installer sync failed:", e)
    finally:
        SYNC_STATE.update(running=False, last_run=now())
        SYNC_LOCK.release()


def sync_async(force=False):
    threading.Thread(target=sync_installers, kwargs={"force": force}, daemon=True).start()


def auto_update_loop():
    time.sleep(5)
    while True:
        try:
            if (get_setting("installer_auto", "1" if INSTALLER_AUTO_UPDATE else "0")) == "1":
                sync_installers()
        except Exception:
            traceback.print_exc()
        time.sleep(6 * 3600)


def download_name(key, info):
    """Branded filename the visitor receives (no upstream product names)."""
    brand = brand_slug()
    if key == "win_exe":
        si = server_info()
        if si["filename_ok"]:
            return si["filename_windows"]  # <Brand>--<config>.exe -> configures itself
        return brand + ".exe"
    ext = os.path.splitext((info or {}).get("file", ""))[1] or ".bin"
    return {"win_msi": brand, "mac_arm": brand, "mac_x64": brand + "-Intel"}.get(key, brand) + ext


def platform_out(key, meta):
    _k, label, os_, arch, _rx, _d = PLATFORM_MAP[key]
    path, src, info = inst_file(key, meta)
    return {
        "key": key, "label": label, "os": os_, "arch": arch, "enabled": inst_enabled(key, meta),
        "available": bool(path), "source": src or "", "version": (info or {}).get("version", ""),
        "size": (info or {}).get("size", 0), "file": download_name(key, info) if path else "",
        "sha256": (info or {}).get("sha256", ""), "updated_at": (info or {}).get("updated_at"),
        "url": "/download/" + key,
    }


def portal_settings():
    return {
        "company": get_setting("portal_company") or APP_NAME,
        "title": get_setting("portal_title") or "Hulp op afstand",
        "intro": get_setting("portal_intro") or
        "Download " + APP_NAME + ", start het programma en geef je ID en wachtwoord door aan de supportmedewerker. "
        "Er wordt pas verbinding gemaakt als jij dat toestaat.",
        "email": get_setting("portal_email"),
        "phone": get_setting("portal_phone"),
    }


@route("GET", "/public-api/info")
def p_info(h):
    meta = inst_meta()
    si = server_info()
    return {
        "name": APP_NAME, "portal": portal_settings(),
        "platforms": [platform_out(k, meta) for k in PLATFORM_MAP if inst_enabled(k, meta)],
        "config_string": si["config_string"] if si["host"] else "",
        "host": si["host"], "windows_auto_config": si["filename_ok"],
    }


@route("GET", "/download/([a-z0-9_]+)")
def p_download(h, key):
    if key not in PLATFORM_MAP:
        raise HttpError(404, "Onbekend platform")
    meta = inst_meta()
    path, src, info = inst_file(key, meta)
    if not path or not inst_enabled(key, meta):
        return h.send(404, "<h1>Download niet beschikbaar</h1><p>Deze installer is (nog) niet beschikbaar. "
                           "Probeer het later opnieuw.</p>", "text/html")
    name = download_name(key, info)
    size = os.path.getsize(path)
    ex("INSERT INTO downloads(platform,ip,user_agent,created_at) VALUES(?,?,?,?)",
       (key, h.client_ip(), (h.headers.get("User-Agent") or "")[:200], now()))
    h.send_response(200)
    h.send_header("Content-Type", "application/octet-stream")
    h.send_header("Content-Length", str(size))
    h.send_header("Content-Disposition", "attachment; filename=\"%s\"" % name.replace('"', ""))
    h.send_header("Cache-Control", "no-store")
    h.send_header("X-Content-Type-Options", "nosniff")
    h.end_headers()
    if h.command == "HEAD":
        return
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1 << 20)
            if not chunk:
                break
            h.wfile.write(chunk)


@route("GET", "/console-api/installers", auth="web")
def c_installers(h):
    meta = inst_meta()
    counts = {r["platform"]: r["c"] for r in q("SELECT platform, COUNT(*) c FROM downloads GROUP BY platform")}
    plats = []
    for k in PLATFORM_MAP:
        p = platform_out(k, meta)
        p["downloads"] = counts.get(k, 0)
        p["has_upload"] = bool(meta.get(k, {}).get("upload"))
        p["github_version"] = meta.get(k, {}).get("github", {}).get("version", "")
        plats.append(p)
    recent = q("SELECT platform, ip, user_agent, created_at FROM downloads ORDER BY pk DESC LIMIT 25")
    since = now() - 30 * 86400
    return {
        "platforms": plats, "sync": SYNC_STATE, "latest": get_setting("installer_latest"),
        "pinned": get_setting("installer_version"),
        "auto": get_setting("installer_auto", "1" if INSTALLER_AUTO_UPDATE else "0") == "1",
        "downloads_30d": q1("SELECT COUNT(*) c FROM downloads WHERE created_at>?", (since,))["c"],
        "recent": recent, "portal": portal_settings(), "public_url": public_url(),
        "server": {k: v for k, v in server_info().items() if k in ("host", "filename_ok", "filename_windows")},
    }


@route("POST", "/console-api/installers/sync", auth="admin")
def c_installers_sync(h):
    b = h.body_json()
    if SYNC_STATE["running"]:
        return {"ok": True, "message": "Synchronisatie loopt al"}
    sync_async(force=bool(b.get("force")))
    return {"ok": True, "message": "Synchronisatie gestart"}


@route("PATCH", "/console-api/installers/([a-z0-9_]+)", auth="admin")
def c_installer_patch(h, key):
    if key not in PLATFORM_MAP:
        raise HttpError(404, "Onbekend platform")
    b = h.body_json()
    meta = inst_meta()
    if "enabled" in b:
        meta.setdefault(key, {})["enabled"] = bool(b["enabled"])
        inst_meta_save(meta)
    return platform_out(key, inst_meta())


@route("PUT", "/console-api/installers/([a-z0-9_]+)/upload", auth="admin")
def c_installer_upload(h, key):
    if key not in PLATFORM_MAP:
        raise HttpError(404, "Onbekend platform")
    n = int(h.headers.get("Content-Length") or 0)
    if n <= 0 or n > 1024 * 1024 * 1024:
        raise HttpError(400, "Leeg bestand of groter dan 1 GB")
    fname = os.path.basename(h.query.get("filename", "") or "installer.bin")
    fname = re.sub(r"[^A-Za-z0-9._()+=,-]", "_", fname)[:150] or "installer.bin"
    d = os.path.join(INSTALLER_DIR, key, "upload")
    os.makedirs(d, exist_ok=True)
    for old in os.listdir(d):
        os.remove(os.path.join(d, old))
    hs = hashlib.sha256()
    left = n
    with open(os.path.join(d, fname), "wb") as f:
        while left > 0:
            chunk = h.rfile.read(min(1 << 20, left))
            if not chunk:
                break
            hs.update(chunk)
            f.write(chunk)
            left -= len(chunk)
    if left:
        raise HttpError(400, "Upload onvolledig")
    meta = inst_meta()
    meta.setdefault(key, {})["upload"] = {
        "file": fname, "version": h.query.get("version", "") or "eigen upload", "size": n,
        "sha256": hs.hexdigest(), "updated_at": now(),
    }
    inst_meta_save(meta)
    return platform_out(key, meta)


@route("DELETE", "/console-api/installers/([a-z0-9_]+)/upload", auth="admin")
def c_installer_upload_delete(h, key):
    if key not in PLATFORM_MAP:
        raise HttpError(404, "Onbekend platform")
    d = os.path.join(INSTALLER_DIR, key, "upload")
    if os.path.isdir(d):
        for old in os.listdir(d):
            os.remove(os.path.join(d, old))
    meta = inst_meta()
    meta.get(key, {}).pop("upload", None)
    inst_meta_save(meta)
    return platform_out(key, meta)


@route("PUT", "/console-api/portal", auth="admin")
def c_portal_put(h):
    b = h.body_json()
    for k in ("company", "title", "intro", "email", "phone"):
        if k in b:
            set_setting("portal_" + k, str(b[k] or "").strip())
    if "public_url" in b:
        set_setting("public_url", str(b["public_url"] or "").strip().rstrip("/"))
    if "auto" in b:
        set_setting("installer_auto", "1" if b["auto"] else "0")
    if "pinned" in b:
        set_setting("installer_version", str(b["pinned"] or "").strip())
    return {"ok": True}


# --------------------------------------------------------------------------
def main():
    init_db()
    threading.Thread(target=auto_update_loop, daemon=True).start()
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    srv.daemon_threads = True
    cert, key = os.environ.get("TLS_CERT", ""), os.environ.get("TLS_KEY", "")
    scheme = "http"
    if cert and key and os.path.isfile(cert) and os.path.isfile(key):
        import ssl
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(cert, key)
        srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
        scheme = "https"
    log("%s console listening on %s://0.0.0.0:%d  (data: %s)" % (APP_NAME, scheme, PORT, os.path.realpath(DATA_DIR)))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
