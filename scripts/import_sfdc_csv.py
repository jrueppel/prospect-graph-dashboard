#!/usr/bin/env python3
"""Convert a Salesforce opportunity report CSV into data/<user>/prospects.json.

Usage: scripts/import_sfdc_csv.py <user_id> <opps.csv> [signals.json]

CSV columns are matched by the names in COLUMNS (edit to fit your report).
Qualification booleans come from optional columns (Y/true/1 = known); anything
missing counts as unknown. signals.json (optional) is {"<Account Name>": {"entities":[...], "signals":[...]}},
which is what the refresh step writes from Slack/Fellow/Gmail/Calendar.
"""
import csv, json, sys, datetime, pathlib

COLUMNS = {"name":"Account Name","amount":"Amount","stage":"Stage","close_date":"Close Date","owner":"Opportunity Owner"}
QUAL_COLUMNS = {k:k.replace("_"," ").title() for k in
                ["champion","economic_buyer","pain","budget","timeline","competitor","next_step"]}
STAGE_MAP = {"Prospecting":"Qualification","Qualification":"Qualification","Discovery":"Discovery",
             "Evaluation":"Evaluation","Proposal":"Proposal","Negotiation":"Negotiation","Closed Won":"Closed Won Pending"}
yes = lambda v: str(v).strip().lower() in ("y","yes","true","1","x")

def main(user, csv_path, sig_path=None):
    sigs = json.load(open(sig_path)) if sig_path else {}
    out = []
    for i, r in enumerate(csv.DictReader(open(csv_path, encoding="utf-8-sig"))):
        name = r[COLUMNS["name"]]
        extra = sigs.get(name, {})
        out.append({"id": f"o{i}", "name": name,
            "amount": float(str(r[COLUMNS["amount"]]).replace("$","").replace(",","") or 0),
            "stage": STAGE_MAP.get(r[COLUMNS["stage"]], r[COLUMNS["stage"]]),
            "close_date": r[COLUMNS["close_date"]], "owner": r.get(COLUMNS["owner"], user),
            "qual": {k: yes(r.get(c, "")) for k, c in QUAL_COLUMNS.items()},
            "entities": extra.get("entities", []), "signals": extra.get("signals", [])})
    d = pathlib.Path("data")/user; d.mkdir(parents=True, exist_ok=True)
    json.dump({"generated": datetime.date.today().isoformat(), "prospects": out}, open(d/"prospects.json","w"), indent=1)
    print(f"wrote {len(out)} prospects to {d/'prospects.json'}")

if __name__ == "__main__":
    if len(sys.argv) < 3: sys.exit(__doc__)
    main(*sys.argv[1:4])
