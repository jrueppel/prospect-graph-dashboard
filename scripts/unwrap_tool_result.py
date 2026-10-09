#!/usr/bin/env python3
"""Usage: unwrap_tool_result.py <saved_tool_result.txt> <user_id>
The browser tool wraps the returned JSON string in [{type,text}] or a bare quoted string; this unwraps it."""
import json, sys, pathlib
raw = open(sys.argv[1]).read()
v, _ = json.JSONDecoder().raw_decode(raw)
if isinstance(v, list): v = v[0]["text"]
d = json.loads(v) if isinstance(v, str) else v
out = pathlib.Path("data")/sys.argv[2]/"prospects.json"; out.parent.mkdir(parents=True, exist_ok=True)
json.dump(d, open(out, "w"), indent=1, ensure_ascii=False)
print(f"wrote {len(d['prospects'])} prospects to {out}")
