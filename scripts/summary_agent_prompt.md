Build deal summaries for {{NAME}} (Enterprise Solutions Engineer at Phrase, {{EMAIL}}). Today is {{TODAY}}. (Fill the placeholders from data/users.json.)

INPUT: a JSON file of deals (Salesforce/SIP fields: account, deal name, AE, stage, amount, SIP next-step note, outcome). For EACH deal, research recent activity (default window: last ~90 days) using the connected tools (load them with ToolSearch first):
- Fellow: search_meetings (title / note_summary / participant domain), get_meeting_summary, get_action_items. Note meeting dates + who attended.
- Gmail: search_threads (account name, key contact domain), then get_thread with messageFormat PLAIN_TEXT for the most relevant 1-2 threads. Ignore automated notifications (Clari, Fellow, Phrase Strings, calendar).
- Slack: slack_search_public_and_private with the account name (keywords), sort by timestamp. Ignore bot/noise channels (crossbeam, summit logistics) and unrelated company-name collisions.
Be efficient: 3-6 tool calls per deal, run independent searches in parallel. Large tool results are saved to a file; use jq/python via Bash to skim them, don't read whole files. NEVER fabricate: every statement must be supported by what you found or by the SIP next-step note. If nothing is found, say so.

OUTPUT: write ONE JSON file (path given below) shaped like this, keyed by opportunity id:
{ "<id>": {
  "as_of": "2026-10-07",
  "headline": "<=14 words: the single most important current fact",
  "status": ["2-4 short sentences: what the customer is doing, where the deal stands, what happened last, key people (first name + role)"],
  "open_items": [{"text":"...","owner":"Name (Company)","due":"date or ''","source":"gmail 10/6 | fellow 9/4 | slack 9/30 | sip"}],
  "watch": ["risks, stalls, mismatched close dates, missing champion/economic buyer, competitor threats"],
  "sources": ["Fellow: N meetings (dates)", "Gmail: ...", "Slack: ..."],
  "signals": [{"date":"YYYY-MM-DD","source":"gmail|slack|fellow","summary":"<=120 chars"}]   // dated real interactions only, newest first, max 6
} }
Rules: use absolute dates; open_items only for things still open (max 7); if no evidence beyond the SIP note, still write a minimal summary from the SIP note, set headline accordingly, list sources as ["SIP/Salesforce next-step note only; no Slack/Gmail/Fellow activity found"] and signals [] (do not invent signals); flag when the SIP next-step note is stale versus real activity; a technical "win" in SIP is not a signed contract, say what the evidence shows. Keep each string concise. Do not write anywhere except the output path. Validate with python json.load before finishing.
Final reply: one line per deal: account, headline, number of signals. Nothing else.
