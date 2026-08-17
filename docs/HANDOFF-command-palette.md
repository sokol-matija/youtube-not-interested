# Handoff: port the ⌘K command palette from the Reddit extension

**Written:** 2026-08-17
**Source repo:** `/Users/msokol/Dev/Repos/2-Personal/reddit-extension` (branch `main`)
**Target repo:** `/Users/msokol/Dev/Repos/2-Personal/youtube-not-interested`
**Goal:** bring the Reddit extension's ⌘K / Ctrl+K palette to the YouTube extension, so navigation, settings toggles, and one-off actions are all reachable from one keyboard-driven popup instead of the options page.

---

## 1. What the Reddit palette does today

Opened with ⌘K (Ctrl+K on Windows). One text input, one list of up to 12 rows, filtered as you type. Arrow keys move the selection, Enter activates it, Escape closes.

Rows are of four kinds, all in the same list and all reachable by type-ahead:

| Kind | Row content | Enter does |
| --- | --- | --- |
| Navigation | Home / Popular / All plus every subscribed subreddit, with its icon | navigates, and bumps a per-URL frequency counter used for ranking |
| Setting toggle | gear-style icon, label, `ON`/`OFF` pill | flips the setting, re-renders, **keeps the palette open** so several can be flipped in a row |
| Submenu | chevron icon, label | swaps the list for a second-level list (Escape steps back to the root list) |
| External action | its own icon | performs the action and closes (e.g. open the current subreddit in a wallpaper gallery in a new tab) |

Ranking: navigation rows are sorted by a frequency map in `localStorage` (`rdh-freq`, `{url: count}`), so the communities you actually visit float to the top. Rows that have been used before get a small `●` marker.

Icons are inline monochrome SVG stroked with `currentColor` (no emoji — that was tried and rejected), stored in a small `ICON` map and referenced per row by name.

## 2. Source of truth to read first

In `reddit-extension/content.js`:

- `PALETTE_STATIC` (~line 343) — static navigation rows.
- `ICON` (~line 350) — the three inline SVGs (`sliders`, `chevron`, `image`).
- `PALETTE_TOGGLES` (~line 359) — the settings exposed in the palette: `[{key, name}]`, where `key` is a storage key.
- `getSubs()` / `getFreq()` / `bumpFreq()` (~line 320–380) — subreddit list fetch + 24h `localStorage` cache, and the frequency ranking.
- `closePalette()` / `openPalette()` (~line 411–553) — the whole widget: build, render, keyboard handling, two-level mode switching.
- The global `keydown` listener (~line 925) — how ⌘K is captured before the site's own shortcuts (`capture: true` plus `stopImmediatePropagation`).

In `reddit-extension/content.css`: the `#rdh-palette` block (input, `ul`, `li`, `li.sel`, `.rdh-ico`, `.rdh-cog`, `.rdh-cog svg`, `.rdh-sw`, `.rdh-pin`). That is roughly 80 lines and ports almost verbatim — only the prefix and colors change.

## 3. Conventions in this repo the port must follow

Checked against the current code, do not re-derive:

- `content.js` is one big IIFE with `'use strict'`, 4-space indent, single quotes.
- Settings are **not** `chrome.storage.sync` with a flat key per setting like the Reddit extension. They are a single `SETTINGS` object in `chrome.storage.local`, accessed through `lib/storage.js`: `Storage.getSettings()` (async, merges `DEFAULT_SETTINGS`) and `Storage.setSettings(patch)` (async, shallow-merges). `Storage` is `self.QuickBlockStorage`.
- `DEFAULT_SETTINGS` lives in `lib/storage.js` (~line 165) — that is the list to pick palette toggles from.
- Live re-apply already exists: the `chrome.storage.onChanged` listener in `content.js` (~line 330) filters on `area === 'local'` and reacts to `changes[Storage.KEYS.SETTINGS]`. A palette toggle therefore needs **no** apply logic of its own — writing through `Storage.setSettings` is enough, the existing listener applies it. Verify each key you expose is actually handled there; a few settings are only read at startup.
- Existing single-key shortcuts (`p` for PiP ~line 236, `c` for cinema mode ~line 259) show the house pattern: bail on `ctrlKey/metaKey/altKey`, bail when the target is `input, textarea, select, [contenteditable]`, and use `capture: true` + `stopPropagation()` when overriding a YouTube binding.
- SPA navigation fires `yt-navigate-finish` (listener ~line 2445). Use it to invalidate anything page-scoped the palette caches (see gotcha 4).
- CSS goes in `styles.css`, class prefix is `quick-block-` / `qb-`. Use `qb-palette` for the port, not `rdh-palette`.
- Content scripts run at `document_idle` here (Reddit's run at `document_start`) — the palette is built on demand, so this does not matter.

## 4. Port plan

### Step 1 — the widget

Copy `openPalette` / `closePalette` into `content.js` inside the existing IIFE, renaming `rdh-` to `qb-`. Three changes while copying, all fixes for known defects in the Reddit version — do not port the defects:

1. **Build rows with the DOM API, not `innerHTML`.** The Reddit version interpolates remote strings (channel/sub names, icon URLs) into an HTML string. Use `createElement` + `textContent` for the label and `img.src = …` for the icon.
2. **Handle mouse.** Rows currently only respond to the keyboard. Add a `click` listener on the `ul` (delegate, read the row index from `dataset.i`) that runs the same activation path as Enter, and a `pointerdown` listener on the backdrop/document that closes the palette when clicking outside.
3. **One activation function.** Pull the Enter body into `activate(item)` so keyboard and mouse share it.

### Step 2 — settings rows

```js
// Settings reachable from the palette, so the options page stays optional.
const PALETTE_TOGGLES = [
    { key: 'hideEnabled',          name: 'Hide watched / not-interested videos' },
    { key: 'cinemaMode',           name: 'Cinema mode' },
    { key: 'focusHideNow',         name: 'Focus mode: hide feed now' },
    { key: 'autoOpenComments',     name: 'Auto-open comments' },
    { key: 'hideBottomComments',   name: 'Hide comments section' },
    { key: 'hideDescription',      name: 'Hide description' },
    { key: 'hideShareButton',      name: 'Hide share button' },
    { key: 'hideMiniGuide',        name: 'Hide collapsed sidebar' },
    { key: 'autoHideMasthead',     name: 'Auto-hide top bar on scroll' },
    { key: 'hideTeaserCarousel',   name: 'Hide teaser carousel' },
    { key: 'karaokeEnabled',       name: 'Karaoke highlighting' },
    { key: 'autoTts',              name: 'Auto read aloud' },
];
```

Read state once when the palette opens, write on Enter:

```js
let cfg = {};
Storage.getSettings().then(s => { cfg = s; render(); });
// …in activate():
if (item.key) {
    cfg[item.key] = !cfg[item.key];
    Storage.setSettings({ [item.key]: cfg[item.key] });   // onChanged applies it
    render();                                            // palette stays open
    return;
}
```

Note the async difference from the Reddit version: `chrome.storage.sync.get(DEFAULTS, cb)` there, `await Storage.getSettings()` here. The palette renders immediately with an empty `cfg` (pills read `OFF`) and re-renders when the promise resolves — same two-phase render the Reddit version uses for its subreddit list.

### Step 3 — navigation rows

Static targets:

```js
const PALETTE_STATIC = [
    { name: 'Home',            url: '/',                  alias: 'home feed' },
    { name: 'Subscriptions',   url: '/feed/subscriptions', alias: 'subs' },
    { name: 'Watch Later',     url: '/playlist?list=WL',   alias: 'wl later queue' },
    { name: 'History',         url: '/feed/history',       alias: 'watched' },
    { name: 'Liked videos',    url: '/playlist?list=LL',   alias: 'likes' },
    { name: 'Your channels',   url: '/feed/channels',      alias: 'subscriptions manage' },
];
```

Channel rows are the one genuinely uncertain piece. YouTube has no equivalent of Reddit's `/subreddits/mine/subscriber.json`. Two options, in order of laziness:

**a) Scrape the guide sidebar** (works whenever the guide has rendered, which is any home/feed page):

```js
function scrapeChannels() {
    const out = [];
    for (const a of document.querySelectorAll('ytd-guide-entry-renderer a#endpoint')) {
        const href = a.getAttribute('href') || '';
        if (!/^\/(@|channel\/|c\/)/.test(href)) continue;      // channels only, not feeds
        out.push({
            name: a.querySelector('.title')?.textContent?.trim() || href,
            url: href,
            icon: a.querySelector('img')?.src || '',
        });
    }
    return out;
}
```

**b) Fetch `/feed/channels` and pull names/URLs out of `ytInitialData`** when the scrape returns nothing (watch pages with a collapsed guide). Regex `/var ytInitialData = (\{.*?\});<\/script>/`, `JSON.parse`, then walk for `browseEndpoint.canonicalBaseUrl`. Slower and more brittle — only as a fallback.

Cache the result in `localStorage` under `qb-channels` with a timestamp, exactly like `getSubs()` does with `rdh-subs` (24h TTL), so the scrape's page-dependence stops mattering after the first successful run. Reuse the `qb-freq` frequency map for ranking, copied verbatim from `getFreq`/`bumpFreq`.

### Step 4 — action rows and submenus

Actions worth having (each is an `{action, name, alias, glyph}` row plus a branch in `activate`):

- **Summarize this video** — only on a watch page; calls the existing summarize entry point.
- **Toggle PiP** — same body as the `p` handler; note it needs a user gesture, and Enter inside the palette counts as one.
- **Copy video link / timestamped link** — `navigator.clipboard.writeText`.
- **Open channel of current video** — reads the channel link from the watch page.
- **Summary profiles** — a submenu (`mode = 'profiles'`) listing `SUMMARY_PROFILES`, Enter sets `activeSummaryProfileId`. This is the direct analogue of the Reddit "Related communities" submenu, so copy that mode-switch code shape.

The two-level mechanics to copy: a `mode` variable, `source` picked by mode inside `render()`, Escape stepping back to the root when `mode` is set, and the input placeholder changing per level.

### Step 5 — CSS

Copy the `#rdh-palette` rules from `reddit-extension/content.css` into `styles.css` as `#qb-palette`. Keep: fixed `top: 18%`, centered with `translateX(-50%)`, 420px wide, `z-index` above the site's own overlays (YouTube's `ytd-popup-container` is high — the Reddit version uses `2147483647`, keep that), 22px round icon slots, `li.sel` tinted with the accent color, the `ON`/`OFF` pill (`.qb-sw`, `.qb-sw.on`), and `.qb-cog svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 2 }`.

### Step 6 — the key binding

```js
document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        e.stopImmediatePropagation();
        openPalette();
    }
}, true);
```

`capture: true` + `stopImmediatePropagation` is what makes it win over the site's own shortcuts. The palette's own input calls `e.stopPropagation()` on every keydown so the page (and the extension's own `p` / `c` handlers) never see typing in the palette — port that too, it is load-bearing.

## 5. Gotchas

1. **⌘K is also a Chrome accelerator** (omnibox search). Page-level `preventDefault` wins on the Reddit extension in practice, but verify on YouTube early. If it does not, fall back to a binding the browser does not claim — `⌘⇧K`, or a bare `/`-style key like `g` — before building anything else on top of it.
2. **YouTube binds a lot of single keys** (`k`, `j`, `l`, `f`, `t`, `c`, `i`, digits). Anything single-key you add needs the capture-phase + `stopPropagation` treatment used by the existing `c` handler, and must bail out when the target is an input.
3. **Do not let the palette's typing reach the player.** Without `stopPropagation` on the palette input, typing "later" would seek and toggle captions in the background.
4. **SPA navigation invalidates page-scoped rows.** Which actions are available depends on the page (watch vs feed). The Reddit version computes availability at open time (`wallpaperUrl()`, `relatedCommunities()`), which is the lazy correct answer: the palette is short-lived, so compute per open and cache nothing page-scoped. Keep that. Only the channel list is cached, and it is not page-scoped.
5. **`document_idle`** means `document.body` always exists by the time the palette can open — no null guard needed.
6. **Orphaned content script.** This repo already guards for "Extension context invalidated" (`extensionAlive()` at the top of `content.js`). `Storage.getSettings()` from a dead context rejects — wrap the palette's storage calls the way the rest of the file does, or the palette will silently render an empty settings state after an extension reload.

## 6. Test checklist

- ⌘K opens on a watch page, a home feed, and a channel page; ⌘K again closes.
- Typing filters; Arrow keys move; Enter navigates; Escape closes.
- A toggle row flips the setting, the pill updates, the palette stays open, and the change takes effect on the page immediately (proves the `onChanged` path).
- Reopen the palette: the toggle state persists and matches the options page.
- Clicking a row activates it; clicking outside closes the palette.
- Typing in the palette does not seek, mute, or toggle captions on the video underneath.
- A submenu row drills in, Escape returns to the root list, Escape again closes.
- Channel rows appear on a feed page, and still appear on a watch page on the next open (proving the cache).
- After reloading the extension, the palette still opens on an old tab or fails gracefully — no unhandled rejection in the console.

## 7. Out of scope for the port

These are open items in the Reddit extension, listed only so they are not mistaken for finished work worth copying: comment-sort popup on comment pages, nav position counter in the pinned title bar, and auto-loading more comments at the end of the tree. None of them are palette code.
