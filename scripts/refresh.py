#!/usr/bin/env python3
"""Refresh deal summaries (data/<user>/summaries.json) from Slack, Gmail and Fellow via headless `claude -p`.

  refresh.py plan [--user jeff]                 show each deal's tier and whether it is due
  refresh.py run  --due [--max 12] [--user jeff] refresh every due deal (used by the daily schedule)
  refresh.py run  --ids ID[,ID] [--user jeff]    force a FULL refresh of specific deals (used by the UI button; never skips)
  refresh.py fingerprints [--user jeff]          one-off: store the SIP-field fingerprint on summaries that lack one (enables the cheap check)
  Cheap check: on a scheduled run each due deal first gets a search-only "anything new since last time?" check (small model).
  Nothing new -> the full run is skipped. A deal is always fully refreshed when its SIP fields changed or after MAX_SKIP_DAYS.
  Every run first snapshots data/<user>/*.json to snapshots/<date>/ and snapshots/latest/ (14 days kept).

Tiers (tune below): daily = important / near close / fresh activity; every 3 days = some activity in 3 weeks;
weekly = sleepy or decided. Research is READ-ONLY: only search/read tools are allowed, nothing can be sent.
Summaries contain customer contact names: data/<user>/ is gitignored, keep it that way.
"""
import argparse, concurrent.futures as cf, datetime as dt, fcntl, hashlib, json, math, pathlib, re, subprocess, sys, time

ROOT = pathlib.Path(__file__).resolve().parent.parent
import os
DATA_DIR = pathlib.Path(os.environ.get("PG_DATA_DIR", ROOT / "data"))
INTERVAL_H = {"daily": 20, "every3days": 68, "weekly": 156}
PARALLEL = 3
PRECHECK = os.environ.get("PG_PRECHECK", "0") == "1"      # opt-in "anything new?" check: measured $0.08/check and 12% skip rate (break-even ~19%), so off by default
CHECK_MODEL = "haiku"                                       # small, fast model: the check only counts hits, it writes nothing
MAX_SKIP_DAYS = 7                                           # never go longer than this without a full refresh, however quiet the deal looks
CHECK_TOOLS = ["mcp__claude_ai_Gmail__search_threads", "mcp__claude_ai_Slack__slack_search_public_and_private", "mcp__claude_ai_Fellow_ai__search_meetings"]
COST_HALT_USD = float(__import__("os").environ.get("PG_DAILY_COST_HALT_USD", "25"))   # hard stop: no new research runs once today's spend reaches this
COST_WARN_USD = float(__import__("os").environ.get("PG_DAILY_COST_WARN_USD", "15"))   # logged as a warning
MODEL = "sonnet"
READ_ONLY_TOOLS = [  # explicit allow-list: no send/draft/label/trash tools
    "mcp__claude_ai_Gmail__search_threads", "mcp__claude_ai_Gmail__get_thread",
    "mcp__claude_ai_Slack__slack_search_public_and_private", "mcp__claude_ai_Slack__slack_read_channel",
    "mcp__claude_ai_Slack__slack_read_thread",
    "mcp__claude_ai_Fellow_ai__search_meetings", "mcp__claude_ai_Fellow_ai__get_meeting_summary",
    "mcp__claude_ai_Fellow_ai__get_action_items", "mcp__claude_ai_Fellow_ai__get_meeting_transcript",
]

# ---------- data ----------
def paths(user):
    d = DATA_DIR / user
    return d, d / "prospects.json", d / "summaries.json", d / "overrides.json", d / "refresh_status.json"

def jload(p, default):
    try: return json.load(open(p))
    except FileNotFoundError: return default

def who(user):
    """Display name / email for the prompt come from the (gitignored) data/users.json - never hard-code people in code."""
    u = next((x for x in jload(DATA_DIR / "users.json", []) if x["id"] == user), {})
    return u.get("name", user), u.get("email", "")

def load(user):
    d, pp, sp, op, _ = paths(user)
    data = jload(pp, {"prospects": []}); ov = jload(op, {}); sums = jload(sp, {})
    for p in data["prospects"]: p.update(ov.get(p["id"], {}))
    return data, sums

# ---------- scoring mirror of scoring.js (keep in sync) ----------
STAGE_PROB = {"Qualification": .05, "Discovery": .10, "Evaluation": .25, "Proposal": .45, "Negotiation": .70, "Closed Won Pending": .95}
QW = {"champion": 2, "economic_buyer": 2, "pain": 1.5, "budget": 1.5, "timeline": 1, "competitor": .5, "next_step": 1.5}

def importance(p, max_amt):
    value = math.sqrt(p["amount"] / max_amt)
    info = sum(w for k, w in QW.items() if p["qual"].get(k)) / sum(QW.values())
    conf = .55 * STAGE_PROB.get(p["stage"], .1) + .45 * info
    if p.get("outcome") == "won": conf = 1 if p.get("signed") else max(conf, .75)
    elif p.get("outcome") == "lost": conf = 0
    return round(100 * value * (.3 + .7 * conf))

def decided(p): return p.get("outcome") == "lost" or (p.get("outcome") == "won" and p.get("signed"))

def classify(p, summ, now, max_amt):
    sig = list(p.get("signals", [])) + (summ or {}).get("signals", [])
    days = min([(now - dt.datetime.fromisoformat(s["date"])).days for s in sig] or [999])
    imp = importance(p, max_amt)
    try: to_close = (dt.datetime.fromisoformat(p["close_date"]) - now).days
    except Exception: to_close = 999
    if decided(p) or (days > 30 and imp < 50): tier = "weekly"          # decided or gone quiet
    elif (imp >= 35 and days <= 7) or (days <= 3 and imp >= 15) or (0 <= to_close <= 14 and days <= 7): tier = "daily"
    elif days <= 21: tier = "every3days"
    else: tier = "weekly"
    return tier, imp, days

def plan(user, now=None):
    now = now or dt.datetime.now()
    data, sums = load(user)
    max_amt = max(p["amount"] for p in data["prospects"])
    rows = []
    for p in data["prospects"]:
        s = sums.get(p["id"]); tier, imp, days = classify(p, s, now, max_amt)
        try: age_h = (now - dt.datetime.fromisoformat(max(s["refreshed_at"], s.get("checked_at") or ""))).total_seconds() / 3600
        except Exception:
            # no timestamp (hand-built summary): only the date is known, so assume it is at least a day old
            try: age_h = (now - dt.datetime.fromisoformat(s["as_of"])).total_seconds() / 3600 + 24 if s else 1e9
            except Exception: age_h = 1e9
        rows.append({"id": p["id"], "name": p["name"], "tier": tier, "importance": imp, "last_signal_days": days,
                     "age_h": round(age_h), "due": age_h >= INTERVAL_H[tier]})
    return sorted(rows, key=lambda r: (-r["due"], ["daily", "every3days", "weekly"].index(r["tier"]), -r["importance"]))

# ---------- backup ----------
def snapshot(user, keep=14):
    """Copy data/<user>/*.json to snapshots/<date>/ and snapshots/latest/ so the app always has last-known data."""
    import shutil
    d = paths(user)[0]; snaps = d / "snapshots"; today = snaps / dt.date.today().isoformat()
    files = [f for f in d.glob("*.json") if f.name != "refresh_status.json"]
    if not files or not jload(paths(user)[1], {}).get("prospects"): return   # never overwrite a good backup with empty data
    for dest in (today, snaps / "latest"):
        dest.mkdir(parents=True, exist_ok=True)
        for f in files: shutil.copy2(f, dest / f.name)
    old = sorted(p for p in snaps.iterdir() if p.is_dir() and p.name != "latest")[:-keep]
    for p in old: shutil.rmtree(p, ignore_errors=True)

# ---------- status + merge (file-locked) ----------
def locked_update(path, fn, default):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(str(path) + ".lock", "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        cur = jload(path, default); new = fn(cur)
        tmp = path.with_suffix(".tmp"); json.dump(new, open(tmp, "w"), indent=1, ensure_ascii=False); tmp.replace(path)

def set_status(user, pid, **kw):
    def f(cur): cur[pid] = {**cur.get(pid, {}), **kw}; return cur
    locked_update(paths(user)[4], f, {})

REQ = ("as_of", "headline", "status", "open_items", "watch", "sources", "signals")
def valid(s):
    return isinstance(s, dict) and all(k in s for k in REQ) and all(
        all(k in o for k in ("text", "owner", "due", "source")) for o in s["open_items"]) and all(
        re.fullmatch(r"\d{4}-\d\d-\d\d", g.get("date", "")) for g in s["signals"])

def merge(user, pid, new, prev):
    seen = set(); sig = []
    for g in sorted(new.get("signals", []) + (prev or {}).get("signals", []), key=lambda g: g["date"], reverse=True):
        k = (g["date"], g["source"], g["summary"][:40])
        if k not in seen: seen.add(k); sig.append(g)
    new["signals"] = sig[:8]
    now = dt.datetime.now(); new["as_of"] = now.date().isoformat(); new["refreshed_at"] = now.isoformat(timespec="seconds")
    def f(cur): cur[pid] = new; return cur
    locked_update(paths(user)[2], f, {})
    # change log: one dated entry per deal whose headline actually changed (feeds the "What moved" digest in the UI)
    if prev and prev.get("headline") != new["headline"]:
        old_keys = {(g["date"], g["source"], g["summary"][:40]) for g in prev.get("signals", [])}
        n_new = sum(1 for g in new["signals"] if (g["date"], g["source"], g["summary"][:40]) not in old_keys)
        entry = {"date": now.date().isoformat(), "id": pid, "headline": new["headline"], "prev": prev.get("headline"), "new_signals": n_new}
        def g(cur):
            cur = [c for c in cur if not (c["date"] == entry["date"] and c["id"] == pid)] + [entry]
            return sorted(cur, key=lambda c: c["date"])[-2000:]
        locked_update(paths(user)[0] / "changelog.json", g, [])

# ---------- research ----------
def prompt_for(p, prev, since, me):
    return f"""You refresh ONE sales deal summary for {me[0]} (Enterprise Solutions Engineer at Phrase{", " + me[1] if me[1] else ""}). Today is {dt.date.today()}.
READ-ONLY research with the Gmail, Slack and Fellow tools. Never send, draft, label or change anything.

DEAL (Salesforce/SIP): {json.dumps({k: p.get(k) for k in ("name", "deal", "owner", "amount", "stage_label", "close_date", "next_step", "outcome", "outcome_note")}, ensure_ascii=False)}
PREVIOUS SUMMARY (as of {(prev or {}).get('as_of', 'never')}): {json.dumps(prev, ensure_ascii=False) if prev else 'none - build from scratch, look back ~90 days'}

Find activity since {since} (Fellow meetings/action items, Gmail threads with the customer, Slack messages naming the account; ignore automated notifications, bots and name collisions). 3-6 tool calls, searches in parallel; use unquoted keywords. Large tool results may be saved to files - skim with jq/head/grep, do not read them whole.
Then UPDATE the summary: keep what is still true, close out open_items that are done, add new ones, refresh headline/status/watch. Be factual: no evidence, no claim. A technical "win" in SIP is not a signed contract. Never include passwords, passcodes, tokens or recording links. If nothing new, keep the previous content and say "no new activity since <date>" in status.

Your FINAL message must be ONLY one JSON object, no prose, no code fences:
{{"as_of":"{dt.date.today()}","headline":"<=14 words","status":["2-4 short sentences"],"open_items":[{{"text":"","owner":"Name (Company)","due":"date or ''","source":"gmail 10/6 | fellow 9/4 | slack 9/30 | sip"}}],"watch":["risks, stale SIP fields, missing champion/economic buyer"],"sources":["Fellow: ...","Gmail: ...","Slack: ..."],"signals":[{{"date":"YYYY-MM-DD","source":"gmail|slack|fellow","summary":"<=120 chars"}}]}}
signals = dated real interactions only, newest first, max 6 (new ones since {since} plus important older ones)."""

def log_usage(user, pid, res, kind="full"):
    """Append one line per research run (cost + tokens) -> data/<user>/usage.jsonl. Feeds the Registry's 'monthly token spend' and the cost guardrail."""
    u = res.get("usage") or {}
    tokens = sum(int(u.get(k) or 0) for k in ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
    line = {"ts": dt.datetime.now().isoformat(timespec="seconds"), "deal": pid, "cost_usd": res.get("total_cost_usd"), "tokens": tokens, "turns": res.get("num_turns"), "kind": kind}
    with open(paths(user)[0] / "usage.jsonl", "a") as f: f.write(json.dumps(line) + "\n")

def sip_fp(p):
    """Fingerprint of the SIP fields that matter: if any of them changed since the last full refresh, a full refresh is always done."""
    raw = "|".join(str(p.get(k)) for k in ("stage_label", "next_step", "close_date", "amount", "outcome"))
    return hashlib.sha1(raw.encode()).hexdigest()[:12]

def check_prompt(p, since):
    return f"""Check whether there is NEW activity on one sales account since {since}. READ-ONLY and search-only: at most three searches, one each in Gmail, Slack and Fellow, run in parallel. Use unquoted keywords taken from the account name. Ignore automated notifications, bots, calendar invites and name collisions with other companies.
ACCOUNT: {p.get("name")}    DEAL: {p.get("deal") or p.get("name")}
Count only items dated {since} or later that are about this account: emails with the customer or internal threads about it, Slack messages naming it, Fellow meetings or notes about it.
Your FINAL message must be ONLY this JSON, no prose, no code fences:
{{"new_activity": true or false, "gmail": <count>, "slack": <count>, "fellow": <count>, "newest": "YYYY-MM-DD or null"}}"""

def check_new_activity(user, pid, p, since):
    """Returns (result dict | None, raw cli json | None). None means the check itself failed: the caller then does the full run."""
    cmd = ["claude", "-p", check_prompt(p, since), "--model", CHECK_MODEL, "--output-format", "json", "--max-turns", "8", "--allowedTools", ",".join(CHECK_TOOLS)]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=150, cwd=ROOT, stdin=subprocess.DEVNULL)
        if out.returncode: return None, None
        res = json.loads(out.stdout); log_usage(user, pid, res, kind="check")
        m = re.search(r"\{.*\}", res.get("result", ""), re.S)
        r = json.loads(m.group(0)) if m else None
        return (r if isinstance(r, dict) and isinstance(r.get("new_activity"), bool) else None), res
    except Exception:
        return None, None

def mark_checked(user, pid, r):
    now = dt.datetime.now().isoformat(timespec="seconds")
    def f(cur):
        if pid in cur: cur[pid]["checked_at"] = now; cur[pid]["last_check"] = {"new_activity": False, **{k: r.get(k) for k in ("gmail", "slack", "fellow")}}
        return cur
    locked_update(paths(user)[2], f, {})

def spent_today(user):
    try: lines = [json.loads(l) for l in open(paths(user)[0] / "usage.jsonl")]
    except FileNotFoundError: return 0.0
    today = dt.date.today().isoformat()
    return sum(float(l.get("cost_usd") or 0) for l in lines if l["ts"].startswith(today))

def run_one(user, pid, force=False):
    spent = spent_today(user)
    if spent >= COST_HALT_USD:        # cost ceiling / kill switch for runaway spend
        msg = f"daily cost ceiling reached (${spent:.2f} >= ${COST_HALT_USD:.0f}); skipped"
        set_status(user, pid, state="error", finished=dt.datetime.now().isoformat(timespec="seconds"), error=msg)
        return pid, f"error: {msg}"
    if spent >= COST_WARN_USD: print(f"  WARNING: today's research spend ${spent:.2f} has passed the ${COST_WARN_USD:.0f} warning level", flush=True)
    data, sums = load(user)
    p = next((x for x in data["prospects"] if x["id"] == pid), None)
    if not p: return pid, "error: unknown deal"
    prev = sums.get(pid)
    since = ((dt.date.fromisoformat(prev["as_of"]) - dt.timedelta(days=2)) if prev else dt.date.today() - dt.timedelta(days=90)).isoformat()
    set_status(user, pid, state="running", started=dt.datetime.now().isoformat(timespec="seconds"), error=None)
    # Cheap check first (scheduled runs only): nothing new since we last looked -> skip the full research run.
    if PRECHECK and not force and prev and prev.get("refreshed_at") and prev.get("sip_fp") == sip_fp(p):
        last_look = max(prev["refreshed_at"], prev.get("checked_at") or "")
        if (dt.datetime.now() - dt.datetime.fromisoformat(prev["refreshed_at"])).days < MAX_SKIP_DAYS:
            r, _ = check_new_activity(user, pid, p, last_look[:10])
            if r is not None and r["new_activity"] is False:
                mark_checked(user, pid, r)
                set_status(user, pid, state="done", finished=dt.datetime.now().isoformat(timespec="seconds"), error=None, result="no_new_activity")
                return pid, "ok (nothing new: full run skipped)"
    cmd = ["claude", "-p", prompt_for(p, prev, since, who(user)), "--model", MODEL, "--output-format", "json",
           "--max-turns", "30", "--allowedTools", ",".join(READ_ONLY_TOOLS + ["Bash(jq:*)", "Bash(head:*)", "Bash(grep:*)", "Read"])]
    err = "unknown"
    for attempt in (1, 2):          # one retry: a Mac that slept mid-run or a flaky connector often works the second time
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=420, cwd=ROOT, stdin=subprocess.DEVNULL)
            if out.returncode: raise RuntimeError(f"claude exited {out.returncode}: {(out.stderr or out.stdout)[:160]}")
            res = json.loads(out.stdout); text = res.get("result", "")
            log_usage(user, pid, res)
            m = re.search(r"\{.*\}", text, re.S)
            if not m: raise RuntimeError("no JSON in model reply: " + text[:120])
            new = json.loads(m.group(0))
            if not valid(new): raise RuntimeError("summary failed schema check")
            new["sip_fp"] = sip_fp(p)
            merge(user, pid, new, prev)
            set_status(user, pid, state="done", finished=dt.datetime.now().isoformat(timespec="seconds"), error=None, result="refreshed")
            return pid, "ok" if attempt == 1 else "ok (retry)"
        except subprocess.TimeoutExpired:
            err = "timed out after 7 min (Mac asleep or connector hung?)"      # never echo the command: it contains the prompt
        except Exception as e:
            err = str(e)[:200]
    set_status(user, pid, state="error", finished=dt.datetime.now().isoformat(timespec="seconds"), error=err)
    return pid, f"error: {err}"

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("cmd", choices=["plan", "run", "fingerprints"]); ap.add_argument("--user", default="jeff")
    ap.add_argument("--due", action="store_true"); ap.add_argument("--force", action="store_true"); ap.add_argument("--ids"); ap.add_argument("--max", type=int, default=15)
    a = ap.parse_args()
    if a.cmd == "fingerprints":
        data, sums = load(a.user); n = [0]
        def f(cur):
            for p in data["prospects"]:
                if p["id"] in cur and "sip_fp" not in cur[p["id"]]: cur[p["id"]]["sip_fp"] = sip_fp(p); n[0] += 1
            return cur
        locked_update(paths(a.user)[2], f, {}); print(f"stored a fingerprint on {n[0]} summaries"); return
    rows = plan(a.user)
    if a.cmd == "plan":
        from collections import Counter
        for r in rows: print(f"{'DUE ' if r['due'] else '    '}{r['tier']:<11}{r['importance']:>3}  last signal {r['last_signal_days']:>3}d  age {r['age_h']:>5}h  {r['name']}")
        print(Counter((r["tier"], r["due"]) for r in rows)); return
    ids = a.ids.split(",") if a.ids else [r["id"] for r in rows if r["due"]][: a.max]
    names = {r["id"]: r["name"] for r in rows}
    snapshot(a.user)
    print(f"{time.strftime('%F %T')} refreshing {len(ids)} deals", flush=True)
    with cf.ThreadPoolExecutor(PARALLEL) as ex:
        for pid, res in ex.map(lambda i: run_one(a.user, i, force=bool(a.ids) or a.force), ids): print(f"  {names.get(pid, pid)}: {res}", flush=True)

if __name__ == "__main__": main()
