# Claude Bridge Setup

Local Node HTTP server (`scripts/claude-bridge.mjs`) that the Chrome extension calls to fetch YouTube transcripts (via Python `youtube-transcript-api`) and to run `claude -p` prompts.

## Ports

| Machine | Bridge port | Why |
| ------- | ----------- | --- |
| macOS   | **7779**    | VoiceMode Player squats 7777 (`~/.voicemode/player/server.py`). |
| Windows | **7777**    | Default. No conflict. |

The extension auto-detects which port the bridge is on. `lib/bridge.js` probes `[7777, 7779]`, caches the live port in `chrome.storage.local`, and exposes `QuickBlockBridge.bridgeUrl(path)` to both `popup.js` and `content.js`.

## Running the bridge

### One-shot (foreground)

```bash
# mac
PORT=7779 node scripts/claude-bridge.mjs

# windows / linux default
node scripts/claude-bridge.mjs
```

`PORT` env var overrides the default `7777`. Dies when the terminal closes.

### Auto-reload on file edits (`node --watch`)

Node 18.11+ has a built-in watcher. With it, editing `scripts/claude-bridge.mjs`
restarts the server automatically — no manual kill + relaunch after a `git pull`.
Without it the old code stays resident in memory until you restart the process.

```bash
# mac (foreground)
PORT=7779 node --watch scripts/claude-bridge.mjs

# windows / linux (foreground)
node --watch scripts/claude-bridge.mjs
```

`--watch` only re-runs on local file changes; it does **not** survive a reboot or
terminal close. For that, combine it with the auto-start setups below (launchd on
macOS, Task Scheduler on Windows) — put `--watch` in the launched command so the
managed process both survives restarts *and* hot-reloads on edits.

### Auto-start at login (macOS, launchd)

Plist: `~/Library/LaunchAgents/com.sokol.yt-bridge.plist`
- `RunAtLoad` + `KeepAlive` — starts at login, restarts on crash
- `PORT=7779`, working dir = repo root
- Logs: `~/.local/state/yt-bridge.log` (stdout), `~/.local/state/yt-bridge.err.log` (stderr)

Manage:

```bash
# load (one-time)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.sokol.yt-bridge.plist

# status
launchctl print gui/$(id -u)/com.sokol.yt-bridge

# restart (after editing the bridge script — only needed if NOT using --watch)
launchctl kickstart -k gui/$(id -u)/com.sokol.yt-bridge

# stop / unload
launchctl bootout gui/$(id -u)/com.sokol.yt-bridge

# tail logs
tail -f ~/.local/state/yt-bridge.log
```

To get hot-reload under launchd, set `ProgramArguments` to run with `--watch`:

```xml
<key>ProgramArguments</key>
<array>
  <string>/opt/homebrew/bin/node</string>
  <string>--watch</string>
  <string>scripts/claude-bridge.mjs</string>
</array>
```

(Match `ProgramArguments[0]` to your `which node`.) Then `launchctl kickstart -k …`
once; afterwards file edits reload automatically and the job still survives logout
and crashes via `KeepAlive`.

### Auto-start at login (Windows, Task Scheduler)

Windows has no launchd. Use **Task Scheduler** for the equivalent "survives reboot,
runs in the background" behavior. Create a task that runs node with `--watch` at
logon.

PowerShell (run once, as your user):

```powershell
$repo = "C:\path\to\youtube-not-interested"          # repo root
$node = (Get-Command node).Source                     # full path to node.exe
$action  = New-ScheduledTaskAction -Execute $node `
  -Argument "--watch scripts/claude-bridge.mjs" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "yt-bridge" `
  -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited
```

Default port 7777 is used on Windows (no `PORT` needed). To override, prefix the
action with `cmd /c "set PORT=7779 && node --watch scripts/claude-bridge.mjs"`.

Manage:

```powershell
Start-ScheduledTask  -TaskName "yt-bridge"   # start now
Stop-ScheduledTask   -TaskName "yt-bridge"   # stop
Get-ScheduledTask    -TaskName "yt-bridge" | Get-ScheduledTaskInfo   # status / last result
Unregister-ScheduledTask -TaskName "yt-bridge" -Confirm:$false       # remove
```

GUI alternative: `taskschd.msc` → Create Task → Trigger "At log on", Action "Start
a program" = `node.exe`, args `--watch scripts/claude-bridge.mjs`, "Start in" = repo
root. Tick "Run task as soon as possible after a scheduled start is missed" and a
restart-on-failure rule under Settings.

With `--watch` in the task's arguments you get the same deal as the macOS plist:
background process that survives reboots **and** hot-reloads on `git pull`.

## Endpoints

| Method | Path          | Body                                | Purpose |
| ------ | ------------- | ----------------------------------- | ------- |
| GET    | `/health`     | —                                   | Liveness + reports active port, default model, python path. |
| POST   | `/transcript` | `{ "videoId": "<11 chars>" }`       | Fetches transcript via Python venv. |
| POST   | `/run`        | `{ "prompt": "...", "model": "..." }` | Runs `claude -p --model <model>`. Models: `haiku`, `sonnet`, `opus`. |

Bound to `127.0.0.1`. Origin allowlist: `https://www.youtube.com`, `https://m.youtube.com`, `chrome-extension://*`, `moz-extension://*`.

## Python venv (for /transcript)

```bash
python3 -m venv scripts/.venv
scripts/.venv/bin/pip install youtube-transcript-api
```

The bridge auto-finds the venv at `scripts/.venv/bin/python` (or `Scripts/python.exe` on Windows). Override with `YTT_PYTHON=/path/to/python`.

## Troubleshooting

**Popup says "Bridge offline"**
- Check the job: `launchctl print gui/$(id -u)/com.sokol.yt-bridge` → look for `state = running`.
- Check the port: `lsof -i :7779 -P -n` (mac) or `:7777` (win).
- Reload the extension after manifest changes (chrome://extensions → reload).

**Port 7777 conflict on mac**
- VoiceMode Player runs `~/.voicemode/player/server.py` on 7777. That's expected — bridge lives on 7779. The extension probes both.
- If you killed VoiceMode and want it back: `cd ~/.voicemode/player && nohup python3 server.py > ~/.voicemode/logs/player.log 2>&1 &`

**Bridge crashes repeatedly under launchd**
- `tail ~/.local/state/yt-bridge.err.log`
- Common: node path changed (homebrew upgrade) — edit `ProgramArguments[0]` in the plist to match `which node`.

## Related files

- `scripts/claude-bridge.mjs` — server
- `lib/bridge.js` — extension-side port resolver
- `manifest.json` — declares `http://localhost:7777/*` + `http://localhost:7779/*` host permissions
- `~/Library/LaunchAgents/com.sokol.yt-bridge.plist` — launchd unit (mac only, not in repo)
