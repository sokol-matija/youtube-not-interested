# Focus Mode schedule — backup before exam block (2026-08-22)

Settings live in `chrome.storage.local`, not in a file, so this is the record.
Restore by hand from the options page. Off-switch password: `options.js:363`.

## Normal (restore this on 2026-09-03)

| Field | Value |
|---|---|
| Hide feeds now | on |
| Blank feeds during schedule | on |
| Days | Mon Tue Wed Thu Fri (weekends off) |
| From | `07:00` |
| To | `12:00` |
| Message | You are free, do something that matters |
| Beam animation | on |

## Exam block (2026-08-22 → 2026-09-02)

Days: all 7 · From `00:00` · To `23:59`

`00:00`→`00:00` does not work — `focusActiveNow()` returns false when start equals end.

## To change either way

Use the **Preset** row in the options page: `Workday` / `Exam`. Switching while
the schedule is on asks for the password, same as turning it off.

The two presets are hardcoded in `options.js` (`FOCUS_PRESETS`) — there is no
preset editor. Change the values there if the workday window moves.

Manual route, for a window neither preset covers: turn **Blank feeds during
schedule** OFF (password), edit days / From / To, turn it back ON.
