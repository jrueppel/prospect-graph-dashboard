# Prospect Graph (v0.1.0-alpha)

> **Alpha.** Works end-to-end on one SE's deals but is unpolished: no auth, local-only server, manual SIP pulls.
> Real deal data lives in `data/<user>/` and is gitignored on purpose (it contains customer contact names). Only fictional sample data is committed.

Run: `python3 -m http.server 8765` then open http://localhost:8765

## Data
`data/prospects.json` (currently SAMPLE data). Per prospect: `amount`, `stage`, `close_date`,
`qual` (champion, economic_buyer, pain, budget, timeline, competitor, next_step: booleans),
`entities` (person | competitor | partner), `signals` (date, source, summary).
Salesforce/Planhat fill amount/stage/close_date/qual; Slack/Fellow/Gmail/Calendar fill signals and entities.

## Scoring (`scoring.js`)
- importance = 100 × sqrt(amount/max) × (0.3 + 0.7 × confidence)
- confidence = 0.55 × stage probability + 0.45 × weighted qualification completeness
- activity = 0.7 × exp(-daysSinceLastSignal/21) + 0.3 × min(1, signals in 30d / 4)
- color: activity 0 = blue, 0.5 = green, 1 = orange

Note: real data will contain contact names/emails. Keep the live `prospects.json` out of any git repo.

## Users (stub)
`data/users.json` lists people; the dropdown (or `?user=<id>`) loads `data/<id>/prospects.json`.
No auth yet: anyone who can reach the server can switch users. To add a teammate, add an entry to
`users.json` and drop their file in `data/<id>/`. Real per-user folders are gitignored.

## Loading real opportunities
`scripts/import_sfdc_csv.py jeff my_opps.csv [signals.json]` (edit column names at the top of the script).

## Refreshing from SIP
Sign in to SIP in the browser pane, then run `scripts/sip_extract.js` on the `/se/deals` page (read-only GET of
`/api/se/deals`, filtered to your SE assignments). Save the result and run `scripts/unwrap_tool_result.py`.
SIP has no champion / economic buyer / budget fields, so those start as unknown; pain, timeline, competitor and
next step are derived from SIP's objective/why-now/competitor/next-step fields. Activity signals come from the SE
stage-change date and the dated next-step note. Fellow/Gmail/Slack enrichment is the next layer.

## Refresh (summaries)
- `python3 scripts/server.py` serves the app on 127.0.0.1:8765 and powers the **Refresh** button (POST /api/refresh).
- `scripts/refresh.py plan` shows each deal's tier; `run --due` refreshes what is due; `run --ids ID` forces one.
- Tiers: daily = importance >= 35 with activity in the last 7 days, or any activity in 3 days (importance >= 15), or closing within 14 days with recent activity;
  every 3 days = some activity in 3 weeks; weekly = decided, or silent > 30 days (unless importance >= 50).
- Research runs headless (`claude -p`, sonnet) with a read-only tool allow-list for Gmail / Slack / Fellow. Nothing can be sent.
- Schedule (weekdays 06:45): `python3 scripts/install_schedule.py jeff` generates and loads the launchd job for THIS folder (re-run it if you move the project).
- The deal list itself (new/removed opportunities, stages) still comes from SIP: re-run `scripts/sip_extract.js` while signed in to SIP.

## Views
- **Open pipeline** (default): all AEs on an orbit ring, or one AE via the dropdown.
- **Closed deals**: closed-won ARR and an area chart over a calendar period (default: last 4 quarters, one colour per quarter), with the closed deals by AE below. Period selector: 2/4/8 quarters, this year, last year.
  Closed deals come from `data/<user>/closed_history.json` (closed-won ARR from the Salesforce Bot posts in #winwire, which carry booked ARR and close date) plus technical losses from SIP.
  SIP's own feed only lists active deals, so there is no other source of closed history.

## Signing in and who can see what
Every request is tied to one signed-in person and can only read that person's own folder (`data/<id>/`). The server serves only the app files: scripts, `.git`, docs, other users' data and `users.json` are unreachable by URL.
- **Local (default):** passphrase login. Accounts are created on the machine that holds the data, never in the web app:
  `python3 scripts/auth.py add-user <id> "<Name>" <email>` then `python3 scripts/auth.py set-passphrase <id>` (stored as a salted PBKDF2 hash; 12-hour HttpOnly session; sign-in throttled after 5 failures).
- **Launchpad:** `PG_AUTH=launchpad`. The gateway signs people in with Okta and adds an `X-Userinfo` header; the server maps the email to exactly one user (unknown emails get nothing). No passwords exist there.
- **Demo:** `/index.html?demo=1` shows the fictional sample data with no sign-in.
- **Audit:** every sign-in, sign-out, data read and refresh is logged (who, when, what, IP) to `data/access.log` and stdout.
- **Tests:** `python3 -m unittest tests.test_auth -v` (23 tests: isolation, path traversal, forged sessions, CSRF, throttling, Launchpad identity handling).
