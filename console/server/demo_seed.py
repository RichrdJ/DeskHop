#!/usr/bin/env python3
"""Fill a running console with demo data by acting like support-app clients.

Usage: python3 demo_seed.py http://localhost:21114 admin <password>
Exercises the real client API (heartbeat, sysinfo, audit, login, address book).
"""
import json
import random
import sys
import urllib.request

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://localhost:21114"
ADMIN = sys.argv[2] if len(sys.argv) > 2 else "admin"
PW = sys.argv[3] if len(sys.argv) > 3 else "admin12345"


def call(method, path, body=None, token=None, raw=False):
    req = urllib.request.Request(BASE + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req) as r:
            data = r.read().decode()
    except urllib.error.HTTPError as e:
        data = e.read().decode()
    if raw:
        return data
    return json.loads(data) if data else None


DEVICES = [
    ("Receptie-PC", "receptie", "Windows 11 Pro / 23H2", "Werkplekken"),
    ("LT-Jansen", "m.jansen", "Windows 11 Enterprise / 24H2", "Werkplekken"),
    ("LT-deVries", "s.devries", "Windows 10 Pro / 22H2", "Werkplekken"),
    ("MacBook-Design", "lisa", "Mac OS 14.5", "Werkplekken"),
    ("SRV-DC01", "Administrator", "Windows Server 2022 / 21H2", "Servers"),
    ("SRV-APP02", "Administrator", "Windows Server 2019", "Servers"),
    ("ubuntu-web01", "root", "Linux / Ubuntu 22.04", "Servers"),
    ("Kassa-01", "kassa", "Windows 10 IoT", None),
    ("Tablet-Magazijn", "magazijn", "Android 14", None),
]

tok = call("POST", "/console-api/login", {"username": ADMIN, "password": PW})["token"]
groups = {g["name"]: g["id"] for g in call("GET", "/console-api/groups", token=tok)}
call("POST", "/console-api/groups", {"name": "Klant: Bakkerij Smit", "color": "#18b26b"}, token=tok)

random.seed(4)
ids = []
for i, (host, user, os_, grp) in enumerate(DEVICES):
    did = str(random.randint(100000000, 1999999999))
    ids.append(did)
    online = i not in (2, 5, 8)
    call("POST", "/api/heartbeat", {"id": did, "uuid": "uuid-%d" % i, "ver": 1003004, "conns": []})
    r = call("POST", "/api/sysinfo", {"id": did, "uuid": "uuid-%d" % i, "hostname": host, "username": user,
                                       "os": os_, "cpu": "Intel Core i7-1265U, 10 cores", "memory": "16 GB",
                                       "version": "1.3.4"}, raw=True)
    assert r == "SYSINFO_UPDATED", r
    if grp:
        call("PATCH", "/console-api/devices/" + did, {"group_id": groups[grp]}, token=tok)
    if not online:
        # pretend last seen a while ago
        import sqlite3, os, time
        db = os.environ.get("DATA_DIR")
        if db:
            c = sqlite3.connect(os.path.join(db, "deskhop.db"))
            c.execute("UPDATE devices SET last_seen=? WHERE id=?", (int(time.time()) - 3600 * (i + 2), did))
            c.commit()

# a few sessions
for n, did in enumerate(ids[:6]):
    cid = 100 + n
    call("POST", "/api/audit/conn", {"id": did, "uuid": "x", "conn_id": cid, "session_id": "s%d" % n, "action": "new", "ip": "84.105.%d.%d" % (n, n * 7)})
    call("POST", "/api/audit/conn", {"id": did, "uuid": "x", "conn_id": cid, "session_id": "s%d" % n,
                                     "peer": {"my_id": "1188812345", "my_name": "helpdesk-richard"}, "type": n % 2})
    if n > 1:
        call("POST", "/api/audit/conn", {"id": did, "uuid": "x", "conn_id": cid, "action": "close"})
# keep 2 active
call("POST", "/api/heartbeat", {"id": ids[0], "uuid": "uuid-0", "ver": 1, "conns": [100]})
call("POST", "/api/heartbeat", {"id": ids[1], "uuid": "uuid-1", "ver": 1, "conns": [101]})
call("POST", "/api/audit/file", {"id": ids[1], "uuid": "x", "peer_id": "1188812345", "type": 0, "path": "C:\\Users\\m.jansen\\Desktop\\update.msi", "is_file": True, "info": "{}"})

# users + client login + address book roundtrip
call("POST", "/console-api/users", {"username": "s.bakker", "display_name": "Sanne Bakker", "email": "s.bakker@example.com", "password": "welkom12345"}, token=tok)
call("POST", "/console-api/users", {"username": "t.peters", "display_name": "Tom Peters", "password": "welkom12345", "is_admin": True}, token=tok)
lr = call("POST", "/api/login", {"username": "s.bakker", "password": "welkom12345", "id": "1188812345", "uuid": "u",
                                  "type": "account", "deviceInfo": {"os": "windows", "type": "client", "name": "HELPDESK-01"}})
ct = lr["access_token"]
assert call("POST", "/api/currentUser", {"id": "1188812345", "uuid": "u"}, token=ct)["name"] == "s.bakker"
assert call("POST", "/api/ab/personal", {}, token=ct).get("error")  # 404 -> legacy
call("POST", "/api/ab", {"data": json.dumps({"tags": ["Klant"], "peers": [{"id": ids[0], "alias": "Receptie", "tags": ["Klant"]}], "tag_colors": "{}"})}, token=ct)
ab = json.loads(call("GET", "/api/ab", token=ct)["data"])
assert ab["peers"][0]["alias"] == "Receptie"
peers = call("GET", "/api/peers?current=1&pageSize=100&accessible=&status=1", token=ct)
assert peers["total"] == len(DEVICES), peers
print("demo data loaded, client API checks passed:", len(DEVICES), "devices")
