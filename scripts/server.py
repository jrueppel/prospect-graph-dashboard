#!/usr/bin/env python3
"""Prospect Graph server: app files + an authenticated, per-user data API. Standard library only.

Every data request is tied to ONE authenticated user and can only read that user's own folder. Nothing else on disk is served.

Auth modes (PG_AUTH):
  local      (default) passphrase login with a signed, HttpOnly session cookie. Set one with: python3 scripts/auth.py set-passphrase <id>
  launchpad  behind the Launchpad gateway: identity comes from the X-Userinfo header the gateway adds after Okta sign-in
             (the gateway strips any client-supplied copy). Requests without it are refused.
  dev        no login; acts as PG_DEV_USER. Refuses to start unless bound to loopback. For tests only.

Env: PG_HOST (127.0.0.1), PG_PORT (8765), PG_DATA_DIR (./data), PG_DEV_USER, PG_SESSION_HOURS (12).
Every sign-in, sign-out, data read and refresh is appended to <data>/access.log (who, when, what, from where).
"""
import base64, hashlib, hmac, json, os, pathlib, re, secrets, subprocess, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = pathlib.Path(os.environ.get("PG_DATA_DIR", ROOT / "data")).resolve()
os.environ["PG_DATA_DIR"] = str(DATA)               # refresh.py reads the same location
sys.path.insert(0, str(ROOT / "scripts"))
import refresh  # noqa: E402

AUTH = os.environ.get("PG_AUTH", "local")
HOST = os.environ.get("PG_HOST", "127.0.0.1")
PORT = int(os.environ.get("PG_PORT", "8765"))
SESSION_S = int(float(os.environ.get("PG_SESSION_HOURS", "12")) * 3600)
LOOPBACK = HOST in ("127.0.0.1", "localhost", "::1")

# Only these app files are ever served (no directory serving: scripts, .git, docs and data are unreachable by URL).
STATIC = {"/": ("index.html", "text/html; charset=utf-8"), "/index.html": ("index.html", "text/html; charset=utf-8"),
          "/login.html": ("login.html", "text/html; charset=utf-8"), "/app.js": ("app.js", "text/javascript"),
          "/closed.js": ("closed.js", "text/javascript"), "/scoring.js": ("scoring.js", "text/javascript"), "/style.css": ("style.css", "text/css")}
DATA_NAME = re.compile(r"^(snapshots/latest/)?(prospects|summaries|overrides|changelog|closed_history|refresh_status)\.json$")
ID_RE = re.compile(r"^[a-z0-9_-]{1,32}$")
FAILS = {}                                           # login throttle: id -> (count, locked_until)

def users():
    try: return json.load(open(DATA / "users.json"))
    except Exception: return []
def user_by(key, val): return next((u for u in users() if str(u.get(key, "")).lower() == str(val).lower()), None)

# ---- local passphrase + session cookie ----
def _secret():
    p = DATA / ".session_secret"
    if not p.exists():
        p.write_text(secrets.token_hex(32)); os.chmod(p, 0o600)
    return bytes.fromhex(p.read_text().strip())
SECRET = _secret()
def check_pass(uid, pw):
    try: j = json.load(open(DATA / uid / "auth.json"))
    except Exception: return None                    # no passphrase set yet
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(j["salt"]), int(j["iter"]))
    return hmac.compare_digest(dk.hex(), j["hash"])
def make_cookie(uid):
    msg = f"{uid}.{int(time.time()) + SESSION_S}"
    return f"{msg}.{hmac.new(SECRET, msg.encode(), hashlib.sha256).hexdigest()}"
def read_cookie(header):
    for part in (header or "").split(";"):
        k, _, v = part.strip().partition("=")
        if k == "pg_session":
            try:
                msg, sig = v.rsplit(".", 1); uid, exp = msg.rsplit(".", 1)
                if hmac.compare_digest(sig, hmac.new(SECRET, msg.encode(), hashlib.sha256).hexdigest()) and int(exp) > time.time() and ID_RE.match(uid): return uid
            except Exception: return None
    return None

class H(BaseHTTPRequestHandler):
    server_version = "ProspectGraph"
    def log_message(self, *a): pass

    # ---- plumbing ----
    def ip(self): return (self.headers.get("X-Forwarded-For", "").split(",")[0].strip() if AUTH == "launchpad" else "") or self.client_address[0]
    def audit(self, user, action, detail=""):
        line = json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "user": user, "action": action, "detail": detail, "ip": self.ip()})
        print("AUDIT " + line, flush=True)                      # stdout: collected by the Launchpad log pipeline
        try:
            with open(DATA / "access.log", "a") as f: f.write(line + "\n")
        except Exception: pass
    def send(self, code, body=b"", ctype="application/json", headers=None):
        if isinstance(body, (dict, list)): body = json.dumps(body).encode()
        elif isinstance(body, str): body = body.encode()
        self.send_response(code); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store"); self.send_header("X-Content-Type-Options", "nosniff"); self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        for k, v in (headers or {}).items(): self.send_header(k, v)
        self.end_headers(); self.wfile.write(body)
    def err(self, code, msg): self.send(code, {"error": msg})

    # ---- identity: returns (user|None, problem|None) ----
    def whoami(self):
        if AUTH == "dev": u = user_by("id", os.environ.get("PG_DEV_USER", "")); return (u, None if u else "dev user not found")
        if AUTH == "launchpad":
            raw = self.headers.get("X-Userinfo")
            if not raw: return (None, "no identity from the gateway")
            try: email = json.loads(base64.b64decode(raw).decode("utf-8"))["email"]
            except Exception: return (None, "unreadable identity")
            u = user_by("email", email)
            return (u, None) if u else (None, f"no data space for {email}")
        uid = read_cookie(self.headers.get("Cookie"))
        u = user_by("id", uid) if uid else None
        return (u, None if u else "not signed in")

    def body(self):
        try: return json.loads(self.rfile.read(min(int(self.headers.get("Content-Length", 0)), 20000)) or b"{}")
        except Exception: return None
    def origin_ok(self):
        o = self.headers.get("Origin")
        return o is None or urlparse(o).netloc == self.headers.get("Host")

    # ---- routes ----
    def do_GET(self):
        path = urlparse(self.path).path
        if path in STATIC:
            name, ctype = STATIC[path]
            if path in ("/", "/index.html") and "demo=1" not in (urlparse(self.path).query or "").split("&"):   # the app page requires a session (the fictional demo does not)
                u, why = self.whoami()
                if not u:
                    if AUTH == "local": return self.send(302, b"", headers={"Location": "/login.html"})
                    return self.send(403 if AUTH == "launchpad" and why and why.startswith("no data") else 401, f"Access denied: {why}", "text/plain; charset=utf-8")
            f = ROOT / name
            if not f.exists(): return self.err(404, "not found")
            body = f.read_bytes()
            if name == "index.html":                                # stamp asset URLs with their newest modification time -> never a stale script/style next to a new page
                v = str(int(max((ROOT / n).stat().st_mtime for n, _ in STATIC.values() if (ROOT / n).exists())))
                body = re.sub(rb'(src|href)="((?:app|closed|scoring)\.js|style\.css)"', lambda m: m.group(1) + b'="' + m.group(2) + b'?v=' + v.encode() + b'"', body)
            return self.send(200, body, ctype)
        if not path.startswith("/api/"): return self.err(404, "not found")          # anything that is not an app file or an API route does not exist
        if path == "/api/me":
            u, why = self.whoami()
            if u: return self.send(200, {"id": u["id"], "name": u["name"], "email": u.get("email", ""), "mode": AUTH})
            return self.err(403 if why and why.startswith("no data") else 401, why)
        if path.startswith("/api/demo/"):                           # fictional sample data, public by design
            n = path[len("/api/demo/"):]; f = DATA / "sample" / n
            return self.send(200, f.read_bytes()) if n == "prospects.json" and f.exists() else self.err(404, "not found")
        u, why = self.whoami()
        if not u: return self.err(401 if not why or not why.startswith("no data") else 403, why)
        if path.startswith("/api/data/"):
            n = path[len("/api/data/"):]
            if not DATA_NAME.match(n): return self.err(404, "not found")
            self.audit(u["id"], "read", n)
            f = DATA / u["id"] / n                                  # always the caller's own folder
            return self.send(200, f.read_bytes()) if f.exists() else self.err(404, "not found")
        if path == "/api/tiers":
            self.audit(u["id"], "read", "tiers")
            return self.send(200, {r["id"]: r for r in refresh.plan(u["id"])})
        return self.err(404, "not found")

    def do_POST(self):
        path = urlparse(self.path).path
        if not self.origin_ok(): return self.err(403, "bad origin")
        b = self.body()
        if b is None: return self.err(400, "bad json")
        if path == "/api/login":
            if AUTH != "local": return self.err(404, "not found")
            key = str(b.get("user", "")).strip(); pw = str(b.get("passphrase", ""))
            u = user_by("id", key) or user_by("email", key); uid = u["id"] if u else key.lower()[:32]
            n, until = FAILS.get(uid, (0, 0))
            if until > time.time(): self.audit(uid, "login-locked"); return self.err(429, "too many attempts, try again in a minute")
            ok = check_pass(u["id"], pw) if u else None
            if ok is None and u: return self.err(401, f"no passphrase set for this account yet: run  python3 scripts/auth.py set-passphrase {u['id']}")
            if not ok:
                FAILS[uid] = (n + 1, time.time() + 60 if n + 1 >= 5 else 0); self.audit(uid, "login-failed")
                return self.err(401, "wrong user or passphrase")                  # same message for unknown user and wrong passphrase
            FAILS.pop(uid, None); self.audit(uid, "login")
            cookie = f"pg_session={make_cookie(uid)}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_S}"
            if self.headers.get("X-Forwarded-Proto") == "https": cookie += "; Secure"
            return self.send(200, {"ok": True}, headers={"Set-Cookie": cookie})
        if path == "/api/logout":
            u, _ = self.whoami()
            if u: self.audit(u["id"], "logout")
            return self.send(200, {"ok": True}, headers={"Set-Cookie": "pg_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"})
        u, why = self.whoami()
        if not u: return self.err(401, why)
        if path == "/api/refresh":
            pid = str(b.get("id", ""))                              # the user comes from the session, never from the request body
            if not re.fullmatch(r"[A-Za-z0-9]{10,24}", pid) or pid not in {p["id"] for p in refresh.load(u["id"])[0]["prospects"]}: return self.err(404, "unknown deal")
            if refresh.jload(refresh.paths(u["id"])[4], {}).get(pid, {}).get("state") == "running": return self.send(202, {"state": "running"})
            refresh.set_status(u["id"], pid, state="running", started=refresh.dt.datetime.now().isoformat(timespec="seconds"), error=None)
            self.audit(u["id"], "refresh", pid)
            log = open(DATA / u["id"] / "refresh.log", "a")
            subprocess.Popen([sys.executable, str(ROOT / "scripts" / "refresh.py"), "run", "--user", u["id"], "--ids", pid], stdout=log, stderr=log, start_new_session=True)
            return self.send(202, {"state": "running"})
        return self.err(404, "not found")

if __name__ == "__main__":
    if AUTH == "dev" and not LOOPBACK: sys.exit("PG_AUTH=dev (no login) is only allowed on a loopback address")
    if AUTH not in ("local", "launchpad", "dev"): sys.exit("PG_AUTH must be local, launchpad or dev")
    print(f"Prospect Graph on http://{HOST}:{PORT}  (auth: {AUTH}, data: {DATA})", flush=True)
    ThreadingHTTPServer((HOST, PORT), H).serve_forever()
