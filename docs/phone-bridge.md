# Phone Summary Bridge

Share a YouTube video from the S25U → the always-on Windows box fetches the
transcript and runs `claude -p` → an ntfy push arrives → tapping it opens the
summary in the Android app.

Desktop summaries made in the extension are mirrored into the same history, so
the phone shows everything regardless of where it was generated.

```
S25U share sheet ──ACTION_SEND──> YtSummaryBridge (Kotlin)
                                       │  POST /api/summarize {url}
                                       ▼
                       sokol:7777   claude-bridge.mjs
                         ├─ oEmbed          → title
                         ├─ youtube-transcript-api (public, no cookies)
                         ├─ claude -p
                         ├─ data/summaries/<videoId>.json
                         └─ ntfy.sh/msokol-general  (Click: ytsum://summary/<id>)
                                       ▲
     Vivaldi extension ────────────────┘
       content.js → background.js → POST /api/summaries/import
```

## Does anything need to survive a restart?

**The MV3 service worker does not, and cannot.** `background.js` is deliberately
ephemeral — Chrome/Vivaldi kills it after ~30s idle and revives it whenever a
message or alarm arrives. Phone sync is triggered by a `chrome.runtime.sendMessage`
from the content script, which wakes it on demand. There is nothing to keep
alive and nothing to configure.

**The Node bridge does, and already is** — on both machines:

| | macOS (`devintosh`) | Windows (`sokol`) |
| --- | --- | --- |
| Manager | launchd `com.sokol.yt-bridge` | Task Scheduler `YouTubeClaudeBridge` |
| Starts at | login (`RunAtLoad`) | logon (LogonTrigger) |
| On crash | `KeepAlive` → immediate restart | RestartCount 3, every 1 min |
| Port | 7779 (loopback only) | 7777 (`0.0.0.0`) |
| Auth | none needed — loopback is exempt | `BRIDGE_TOKEN` required off-loopback |
| Role | serves the local extension only | serves the phone **and** both extensions |

Only the Windows one matters for the phone. If the MacBook is asleep, the phone
is unaffected — that is why the bridge lives there.

## Known trap: launchd serves stale code after a `git pull`

Neither job runs with `--watch`, so the process keeps the code it loaded at
start. Pulling a fix and not restarting means the old code keeps running while
the corrected file sits on disk. This has already caused two confusing bugs.

Restart after any pull:

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.sokol.yt-bridge

# Windows
Stop-ScheduledTask -TaskName "YouTubeClaudeBridge"
Start-ScheduledTask -TaskName "YouTubeClaudeBridge"
```

To make the Mac reload itself instead, add `--watch` as `ProgramArguments[1]`
(before the script path) and `launchctl kickstart -k` once. `KeepAlive` still
covers reboots and crashes.

## Extension gotchas

Both have cost real debugging time.

**1. Reloading the extension orphans open YouTube tabs.** The already-injected
content script keeps running but its `chrome.*` APIs are dead
("Extension context invalidated"). Plain `fetch` still works, so a transcript
request succeeds and the next `chrome.storage` read throws — which looks like a
hang, not an error. **Always reload open YouTube tabs after reloading the
extension.**

**2. Remote `http://` must go through `background.js`.** A content script on an
`https://www.youtube.com` page cannot fetch plain `http://` to a remote host;
Chrome blocks it as mixed content and the caller sees only a rejected promise.
`http://localhost` is exempt (secure context), which is why `7777`/`7779` work
from the page and `sokol.falcon-parore.ts.net:7777` does not. Anything new that
talks to a remote host over plain HTTP belongs in the service worker, alongside
the phone sync and the Kokoro TTS call.

## Setup on a new machine

1. Pull the repo, load the extension unpacked.
2. Options → **Phone sync token** → paste the bridge's `BRIDGE_TOKEN`. Click
   away from the field — it saves on `change` (blur), not per keystroke, and
   confirms with a toast.
3. Without a token, sync is a silent no-op by design. A token that is set but
   failing *does* toast — that distinction is deliberate.

## Windows bridge environment

Set as **User** environment variables, not in the repo:

| Variable | Value | Why |
| --- | --- | --- |
| `BRIDGE_BIND` | `0.0.0.0` | phone must reach it over Tailscale |
| `BRIDGE_TOKEN` | 48-hex secret | every non-loopback request needs it |
| `NTFY_TOPIC` | `msokol-general` | already subscribed on the phone |
| `CLAUDE_MODEL` | `sonnet` | default for phone-initiated jobs |

They are not in the repo and not in the scheduled task definition, so a rebuilt
user profile loses them. Re-set with `[Environment]::SetEnvironmentVariable(...,"User")`
and restart the task.

## Rotating the token

Needed if it ever leaks (it has once — a hardcoded literal reached a public
commit; it is now read from `chrome.storage`).

1. Generate: `openssl rand -hex 24`
2. Windows: set `BRIDGE_TOKEN`, restart the task
3. Extension: Options → Phone sync token, on **each** machine
4. Android: `Config.TOKEN` in `youtube-summary-bridge`, rebuild, reinstall
5. Verify the old token returns `401` and the new one `200`

`Config.kt` still holds the token as a literal. That repo has no remote, which
is the only reason it is safe — fix this properly before ever adding one.

## Verifying

```bash
TOKEN=...   # BRIDGE_TOKEN
B=http://sokol.falcon-parore.ts.net:7777

curl -s -H "Authorization: Bearer $TOKEN" $B/health
curl -s -o /dev/null -w '%{http_code}\n' $B/api/summaries      # want 401
curl -s -H "Authorization: Bearer $TOKEN" $B/api/summaries     # the history

# end to end, without touching the phone
adb shell am start -a android.intent.action.SEND -t text/plain \
  --es android.intent.extra.TEXT "https://youtu.be/<id>" \
  -n com.sokolmatija.ytsummary/.ShareReceiverActivity

# did a desktop summary mirror across? look for "source": "extension"
curl -s -H "Authorization: Bearer $TOKEN" $B/api/summaries/<videoId>
```

Bridge logs: `~/.local/state/yt-bridge.log` (mac), `scripts\bridge.log` (windows).
A `/transcript` line with no following `NNNNch → NNNch` line means the extension
died between fetching the transcript and calling Claude — almost always trap #1.

Wireless adb drops its port constantly; rediscover with `adb mdns services`
rather than assuming the last one still works.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/summarize` | `{url}` → 202, job runs async, ntfy on completion |
| GET | `/api/summaries` | history, newest first |
| GET | `/api/summaries/:id` | one record (transcript stripped) |
| POST | `/api/summaries/:id/regenerate` | re-run from the cached transcript |
| POST | `/api/summaries/:id/audio` | one append to the ttsplayer at `:7780` |
| POST | `/api/summaries/import` | file a summary made in the extension |
| GET | `/api/profiles` | the six prompt presets |

Records live in `data/summaries/` (gitignored) with no cap — unlike the
extension's `chrome.storage` cache, which evicts at 50.
