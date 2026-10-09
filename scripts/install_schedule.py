#!/usr/bin/env python3
"""(Re)install the weekday 06:45 refresh job (launchd) pointing at THIS folder. Safe to re-run after moving the project.
Usage: python3 scripts/install_schedule.py [user]        Remove: launchctl unload ~/Library/LaunchAgents/com.phrase.prospect-graph.refresh.plist"""
import pathlib, subprocess, sys
ROOT = pathlib.Path(__file__).resolve().parent.parent; user = sys.argv[1] if len(sys.argv) > 1 else "jeff"
label = "com.phrase.prospect-graph.refresh"; dest = pathlib.Path.home() / "Library/LaunchAgents" / f"{label}.plist"
days = "".join(f"<dict><key>Weekday</key><integer>{d}</integer><key>Hour</key><integer>6</integer><key>Minute</key><integer>45</integer></dict>" for d in range(1, 6))
plist = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>{label}</string>
<key>ProgramArguments</key><array><string>/usr/bin/caffeinate</string><string>-i</string><string>/usr/bin/python3</string><string>{ROOT}/scripts/refresh.py</string><string>run</string><string>--due</string><string>--user</string><string>{user}</string></array>
<key>WorkingDirectory</key><string>{ROOT}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
<key>StartCalendarInterval</key><array>{days}</array>
<key>StandardOutPath</key><string>{ROOT}/data/{user}/refresh.log</string>
<key>StandardErrorPath</key><string>{ROOT}/data/{user}/refresh.log</string>
</dict></plist>
"""
subprocess.run(["launchctl", "unload", str(dest)], capture_output=True)
dest.write_text(plist); subprocess.run(["plutil", "-lint", str(dest)], check=True)
subprocess.run(["launchctl", "load", str(dest)], check=True); print(f"installed {label} -> {ROOT}")
