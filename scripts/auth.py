#!/usr/bin/env python3
"""Manage local sign-in for Prospect Graph (PG_AUTH=local).

  auth.py set-passphrase <id>     prompt for a passphrase (min 10 characters) and store only a salted PBKDF2 hash in data/<id>/auth.json
  auth.py add-user <id> "<Name>" <email>   add a person to data/users.json (creates their empty data folder)
  auth.py list                    show users and whether a passphrase is set

No one can create their own account through the web app: accounts and passphrases are set here, on the machine that holds the data.
"""
import getpass, hashlib, json, os, pathlib, re, secrets, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = pathlib.Path(os.environ.get("PG_DATA_DIR", ROOT / "data"))
ITER = 600_000

def load():
    try: return json.load(open(DATA / "users.json"))
    except FileNotFoundError: return []

def main(a):
    if not a: sys.exit(__doc__)
    if a[0] == "list":
        for u in load(): print(f"{u['id']:<12} {u.get('email',''):<34} passphrase: {'set' if (DATA/u['id']/'auth.json').exists() else 'NOT SET'}")
    elif a[0] == "add-user" and len(a) == 4:
        uid, name, email = a[1], a[2], a[3]
        if not re.fullmatch(r"[a-z0-9_-]{1,32}", uid): sys.exit("id must be lowercase letters, digits, - or _")
        us = load()
        if any(u["id"] == uid or u.get("email", "").lower() == email.lower() for u in us): sys.exit("user id or email already exists")
        us.append({"id": uid, "name": name, "email": email}); (DATA / uid).mkdir(parents=True, exist_ok=True)
        json.dump(us, open(DATA / "users.json", "w"), indent=2); print(f"added {uid}; now run: auth.py set-passphrase {uid}")
    elif a[0] == "set-passphrase" and len(a) == 2:
        uid = a[1]
        if not any(u["id"] == uid for u in load()): sys.exit(f"unknown user '{uid}' (see: auth.py list)")
        p1 = getpass.getpass("New passphrase: "); p2 = getpass.getpass("Repeat: ")
        if p1 != p2: sys.exit("passphrases do not match")
        if len(p1) < 10: sys.exit("use at least 10 characters (a few random words works well)")
        salt = secrets.token_bytes(16); h = hashlib.pbkdf2_hmac("sha256", p1.encode(), salt, ITER)
        (DATA / uid).mkdir(parents=True, exist_ok=True)
        json.dump({"salt": salt.hex(), "iter": ITER, "hash": h.hex()}, open(DATA / uid / "auth.json", "w")); os.chmod(DATA / uid / "auth.json", 0o600)
        print(f"passphrase set for {uid}")
    else: sys.exit(__doc__)

if __name__ == "__main__": main(sys.argv[1:])
