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

# restart (after editing the bridge script)
launchctl kickstart -k gui/$(id -u)/com.sokol.yt-bridge

# stop / unload
launchctl bootout gui/$(id -u)/com.sokol.yt-bridge

# tail logs
tail -f ~/.local/state/yt-bridge.log
```

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
