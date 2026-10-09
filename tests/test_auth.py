"""Security tests for the Prospect Graph server: sign-in, per-user isolation, file exposure, CSRF, throttling, audit log.
Run:  python3 -m unittest tests.test_auth -v      (uses a throwaway data directory and users alice / bob, never your real data)"""
import base64, hashlib, http.client, json, os, pathlib, secrets, socket, subprocess, sys, tempfile, time, unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
PASS = {"alice": "alice-test-passphrase-1", "bob": "bob-test-passphrase-2"}

def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p

def hashed(pw):
    salt = secrets.token_bytes(16); return {"salt": salt.hex(), "iter": 1000, "hash": hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, 1000).hex()}

def make_data():
    d = pathlib.Path(tempfile.mkdtemp(prefix="pg-test-"))
    (d / "users.json").write_text(json.dumps([{"id": "alice", "name": "Alice Test", "email": "alice@example.test"},
                                              {"id": "bob", "name": "Bob Test", "email": "bob@example.test"}]))
    for u in ("alice", "bob"):
        (d / u).mkdir()
        (d / u / "prospects.json").write_text(json.dumps({"generated": "2026-10-08", "prospects": [{"id": f"{u}Deal0000001", "name": f"SECRET-{u.upper()}-DEAL"}]}))
        (d / u / "summaries.json").write_text(json.dumps({f"{u}Deal0000001": {"headline": f"{u} private headline"}}))
        (d / u / "auth.json").write_text(json.dumps(hashed(PASS[u])))
    (d / "sample").mkdir(); (d / "sample" / "prospects.json").write_text(json.dumps({"prospects": [{"id": "p1", "name": "Fictional Co"}]}))
    return d

class Srv:
    def __init__(self, data, mode, extra=None):
        self.port = free_port(); env = dict(os.environ, PG_DATA_DIR=str(data), PG_PORT=str(self.port), PG_AUTH=mode, **(extra or {}))
        self.p = subprocess.Popen([sys.executable, str(ROOT / "scripts" / "server.py")], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try: socket.create_connection(("127.0.0.1", self.port), 0.2).close(); break
            except OSError: time.sleep(0.05)
    def req(self, method, path, body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10); h = dict(headers or {})
        if body is not None: h["Content-Type"] = "application/json"; body = json.dumps(body)
        c.request(method, path, body, h); r = c.getresponse(); raw = r.read(); c.close()
        try: js = json.loads(raw)
        except Exception: js = None
        return r.status, js, raw, r.getheader("Set-Cookie")
    def login(self, user, pw):
        st, js, _, ck = self.req("POST", "/api/login", {"user": user, "passphrase": pw}); return st, (ck or "").split(";")[0]
    def stop(self): self.p.terminate(); self.p.wait(5)

class LocalMode(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.data = make_data(); cls.s = Srv(cls.data, "local")
    @classmethod
    def tearDownClass(cls): cls.s.stop()

    def test_01_nothing_without_signing_in(self):
        for p in ("/api/me", "/api/data/prospects.json", "/api/data/summaries.json", "/api/tiers"):
            self.assertEqual(self.s.req("GET", p)[0], 401, p)
        st, _, _, _ = self.s.req("GET", "/"); self.assertEqual(st, 302)            # app page redirects to the sign-in page
        self.assertEqual(self.s.req("GET", "/login.html")[0], 200)

    def test_02_files_that_must_never_be_served(self):
        for p in ("/data/alice/prospects.json", "/data/users.json", "/users.json", "/scripts/refresh.py", "/scripts/server.py", "/.git/config",
                  "/docs/x.png", "/tests/test_auth.py", "/README.md", "/..%2fdata%2fusers.json", "/%2e%2e/%2e%2e/etc/passwd", "/data/alice/auth.json"):
            self.assertEqual(self.s.req("GET", p)[0], 404, p)

    def test_03_wrong_credentials_rejected_with_one_message(self):
        a = self.s.req("POST", "/api/login", {"user": "alice", "passphrase": "nope-nope-nope"}); b = self.s.req("POST", "/api/login", {"user": "ghost", "passphrase": "nope-nope-nope"})
        self.assertEqual((a[0], b[0]), (401, 401)); self.assertEqual(a[1], b[1])           # unknown user looks identical to wrong passphrase

    def test_04_each_user_sees_only_their_own_data(self):
        _, ca = self.s.login("alice", PASS["alice"]); _, cb = self.s.login("bob", PASS["bob"]); self.assertTrue(ca and cb)
        sa, ja, ra, _ = self.s.req("GET", "/api/data/prospects.json", headers={"Cookie": ca}); sb, jb, rb, _ = self.s.req("GET", "/api/data/prospects.json", headers={"Cookie": cb})
        self.assertEqual((sa, sb), (200, 200)); self.assertIn(b"SECRET-ALICE-DEAL", ra); self.assertNotIn(b"BOB", ra)
        self.assertIn(b"SECRET-BOB-DEAL", rb); self.assertNotIn(b"ALICE", rb)
        self.assertEqual(self.s.req("GET", "/api/me", headers={"Cookie": ca})[1]["id"], "alice")

    def test_05_cannot_ask_for_someone_elses_data(self):
        _, ca = self.s.login("alice", PASS["alice"])
        for p in ("/api/data/../bob/prospects.json", "/api/data/%2e%2e/bob/prospects.json", "/api/data/snapshots/latest/../../bob/prospects.json",
                  "/api/data/bob/prospects.json", "/api/data/../users.json", "/api/data/auth.json", "/api/data/prospects.json?user=bob", "/api/data/prospects.json/../../bob/summaries.json"):
            st, _, raw, _ = self.s.req("GET", p, headers={"Cookie": ca}); self.assertNotIn(b"BOB", raw.upper().replace(b"BOB TEST", b"")) if st == 200 else None
            self.assertNotIn(b"bob private headline", raw, p); self.assertNotIn(b"SECRET-BOB-DEAL", raw, p)

    def test_06_forged_or_tampered_sessions_are_refused(self):
        _, ca = self.s.login("alice", PASS["alice"]); val = ca.split("=", 1)[1]; uid, exp, sig = val.split(".")
        for bad in (f"pg_session=bob.{exp}.{sig}", f"pg_session={uid}.{exp}.{'0'*64}", f"pg_session=bob.{int(time.time())+999}.{sig}", "pg_session=bob", "pg_session=", "pg_session=alice.1.abc"):
            self.assertEqual(self.s.req("GET", "/api/data/prospects.json", headers={"Cookie": bad})[0], 401, bad)

    def test_07_session_cookie_flags(self):
        st, _, _, ck = self.s.req("POST", "/api/login", {"user": "alice", "passphrase": PASS["alice"]})
        self.assertIn("HttpOnly", ck); self.assertIn("SameSite=Strict", ck)

    def test_08_logout_ends_the_session_cookie(self):
        _, ca = self.s.login("alice", PASS["alice"]); st, _, _, ck = self.s.req("POST", "/api/logout", headers={"Cookie": ca}); self.assertIn("Max-Age=0", ck)

    def test_09_cross_site_posts_refused(self):
        _, ca = self.s.login("alice", PASS["alice"])
        st, *_ = self.s.req("POST", "/api/refresh", {"id": "aliceDeal0000001"}, {"Cookie": ca, "Origin": "http://evil.example"}); self.assertEqual(st, 403)

    def test_10_refresh_uses_the_session_user_only(self):
        _, ca = self.s.login("alice", PASS["alice"])
        st, js, *_ = self.s.req("POST", "/api/refresh", {"id": "bobDeal00000001", "user": "bob"}, {"Cookie": ca}); self.assertEqual(st, 404)   # bob's deal id means nothing to alice

    def test_11_login_is_throttled(self):
        codes = [self.s.req("POST", "/api/login", {"user": "bob", "passphrase": f"wrong-passphrase-{i}"})[0] for i in range(7)]
        self.assertIn(429, codes); self.assertEqual(self.s.req("POST", "/api/login", {"user": "bob", "passphrase": PASS["bob"]})[0], 429)   # even the right one waits

    def test_12_demo_data_is_public_and_fictional_only(self):
        st, _, raw, _ = self.s.req("GET", "/api/demo/prospects.json"); self.assertEqual(st, 200); self.assertIn(b"Fictional Co", raw)
        for p in ("/api/demo/summaries.json", "/api/demo/../alice/prospects.json"): self.assertEqual(self.s.req("GET", p)[0], 404, p)

    def test_12b_demo_page_loads_without_signing_in_but_the_real_app_page_does_not(self):
        self.assertEqual(self.s.req("GET", "/index.html?demo=1")[0], 200); self.assertEqual(self.s.req("GET", "/index.html")[0], 302)
        self.assertEqual(self.s.req("GET", "/index.html?x=demo=1")[0], 302)                 # cannot be spoofed by a look-alike parameter

    def test_13_security_headers(self):
        c = http.client.HTTPConnection("127.0.0.1", self.s.port); c.request("GET", "/login.html"); r = c.getresponse(); r.read()
        self.assertEqual(r.getheader("X-Frame-Options"), "DENY"); self.assertEqual(r.getheader("Cache-Control"), "no-store"); self.assertEqual(r.getheader("X-Content-Type-Options"), "nosniff")

    def test_99_everything_is_in_the_access_log(self):
        log = (self.data / "access.log").read_text(); actions = {json.loads(l)["action"] for l in log.splitlines()}
        self.assertTrue({"login", "login-failed", "read", "logout"} <= actions, actions)

class LaunchpadMode(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.data = make_data(); cls.s = Srv(cls.data, "launchpad")
    @classmethod
    def tearDownClass(cls): cls.s.stop()
    @staticmethod
    def hdr(email): return {"X-Userinfo": base64.b64encode(json.dumps({"email": email, "name": "x"}).encode()).decode()}

    def test_no_identity_header_is_refused(self): self.assertEqual(self.s.req("GET", "/api/data/prospects.json")[0], 401)
    def test_identity_maps_to_exactly_that_users_data(self):
        st, _, raw, _ = self.s.req("GET", "/api/data/prospects.json", headers=self.hdr("bob@example.test")); self.assertEqual(st, 200); self.assertIn(b"SECRET-BOB-DEAL", raw); self.assertNotIn(b"ALICE", raw)
    def test_email_match_is_case_insensitive_but_exact(self):
        self.assertEqual(self.s.req("GET", "/api/me", headers=self.hdr("ALICE@Example.TEST"))[1]["id"], "alice")
        self.assertEqual(self.s.req("GET", "/api/me", headers=self.hdr("alice@example.test.evil.com"))[0], 403)
    def test_unknown_person_gets_no_data(self): self.assertEqual(self.s.req("GET", "/api/data/prospects.json", headers=self.hdr("stranger@phrase.com"))[0], 403)
    def test_garbage_identity_is_refused(self): self.assertEqual(self.s.req("GET", "/api/data/prospects.json", headers={"X-Userinfo": "%%%not-base64"})[0], 401)
    def test_password_login_endpoint_is_disabled_behind_the_gateway(self): self.assertEqual(self.s.req("POST", "/api/login", {"user": "alice", "passphrase": PASS["alice"]})[0], 404)
    def test_app_page_denied_without_identity(self): self.assertEqual(self.s.req("GET", "/")[0], 401)

class DevMode(unittest.TestCase):
    def test_dev_mode_refuses_to_start_on_a_public_interface(self):
        d = make_data(); r = subprocess.run([sys.executable, str(ROOT / "scripts" / "server.py")], env=dict(os.environ, PG_DATA_DIR=str(d), PG_AUTH="dev", PG_HOST="0.0.0.0", PG_PORT=str(free_port())), capture_output=True, text=True, timeout=10)
        self.assertNotEqual(r.returncode, 0); self.assertIn("loopback", r.stderr + r.stdout)

if __name__ == "__main__": unittest.main()
