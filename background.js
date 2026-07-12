// Service worker. Periodic + on-demand Watch Later sync.
// Uses chrome.scripting MAIN world to access ytcfg + cookied fetch.
// (Transcript fetching lives in the local bridge — see scripts/claude-bridge.mjs.)

importScripts('lib/storage.js');

const SYNC_ALARM = 'wl-sync';
const SYNC_PERIOD_MIN = 360;
const KOKORO_BASE = 'http://sokol.falcon-parore.ts.net:8880';
const KOKORO_URL = `${KOKORO_BASE}/v1/audio/speech`;
const KOKORO_CAPTIONED_URL = `${KOKORO_BASE}/dev/captioned_speech`;
const KOKORO_VOICE = 'af_sky';

chrome.action.onClicked.addListener(() => {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
});

chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MIN, delayInMinutes: 1 });
    triggerSync();
});

chrome.runtime.onStartup.addListener(() => {
    chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MIN });
});

chrome.alarms.onAlarm.addListener(a => {
    if (a.name === SYNC_ALARM) triggerSync();
});

// App-switch auto-PiP: the browser only auto-enters PiP when the video tab
// goes hidden, and alt-tabbing to another app leaves it visible (minimizing
// doesn't fire it either, at least on Vivaldi/macOS). So when the browser
// loses focus while the active tab is playing YouTube, park a blank tab on
// top of it — the video tab goes hidden, auto-PiP fires, and the overlay
// floats above whatever app you switched to. Refocusing the browser (or
// PiP's "back to tab" button) restores the video tab and drops the parking
// tab, which auto-closes the PiP window.
const PIP_PARK_KEY = 'autoPipParkedTab';

chrome.windows.onFocusChanged.addListener(async winId => {
    try {
        if (winId === chrome.windows.WINDOW_ID_NONE) {
            const settings = await self.QuickBlockStorage.getSettings();
            if (settings.autoPip === false) return;
            const { [PIP_PARK_KEY]: parked } = await chrome.storage.session.get(PIP_PARK_KEY);
            if (parked) return;
            const win = await chrome.windows.getLastFocused({ populate: true });
            if (!win || win.state === 'minimized') return;
            const tab = win.tabs?.find(t => t.active);
            if (!tab?.audible || !/youtube\.com\/watch/.test(tab.url || '')) return;
            const temp = await chrome.tabs.create({
                windowId: win.id,
                url: 'about:blank',
                active: true,
            });
            await chrome.storage.session.set({
                [PIP_PARK_KEY]: { tempId: temp.id, videoId: tab.id },
            });
            console.log('[autopip] parked video tab', tab.id);
        } else {
            const { [PIP_PARK_KEY]: parked } = await chrome.storage.session.get(PIP_PARK_KEY);
            if (!parked) return;
            await chrome.storage.session.remove(PIP_PARK_KEY);
            await chrome.tabs.update(parked.videoId, { active: true }).catch(() => {});
            chrome.tabs.remove(parked.tempId).catch(() => {});
        }
    } catch (e) { console.warn('[autopip] error', e); }
});

// Global shortcut (works while another app is focused): toggle PiP on the
// playing YouTube tab. The command counts as a user gesture, which
// executeScript carries into the page — requestPictureInPicture is allowed.
chrome.commands.onCommand.addListener(cmd => {
    if (cmd === 'toggle-pip') togglePip();
});

async function togglePip() {
    const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
    if (!tabs.length) return;
    const tab = tabs.find(t => t.audible) || tabs.find(t => t.active) || tabs[0];
    await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: () => {
            const v = document.querySelector('video.html5-main-video')
                || document.querySelector('video');
            if (!v) return;
            if (document.pictureInPictureElement) {
                document.exitPictureInPicture().catch(() => {});
            } else {
                // Marked so autopip.js closes it when the tab regains focus.
                v.dataset.qbPip = '1';
                v.requestPictureInPicture().catch(() => {});
            }
        },
    }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'request-sync') {
        triggerSync().then(sendResponse);
        return true;
    }
    if (msg?.type === 'tts-generate') {
        ttsGenerate(msg.text).then(sendResponse);
        return true;
    }
});

async function ttsGenerate(text) {
    if (!text || typeof text !== 'string') {
        return { ok: false, error: 'empty text' };
    }
    // Preferred path: captioned endpoint returns base64 audio + per-word
    // timestamps (used to drive the karaoke pill). JSON body, not a blob.
    try {
        const r = await fetch(KOKORO_CAPTIONED_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'kokoro',
                input: text,
                voice: KOKORO_VOICE,
                response_format: 'mp3',
                stream: false,
                return_timestamps: true,
            }),
        });
        if (r.ok) {
            const data = await r.json();
            if (data?.audio) {
                const fmt = data.audio_format || 'audio/mpeg';
                return {
                    ok: true,
                    dataUrl: `data:${fmt};base64,${data.audio}`,
                    timestamps: Array.isArray(data.timestamps) ? data.timestamps : null,
                };
            }
        }
        // Non-OK / no audio → fall through to the plain endpoint below.
    } catch {
        // Network error on captioned — try the plain endpoint before failing.
    }

    // Fallback: plain speech (mp3 blob, no timestamps → no karaoke).
    try {
        const r = await fetch(KOKORO_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'tts-1',
                input: text,
                voice: KOKORO_VOICE,
                response_format: 'mp3',
            }),
        });
        if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
        const blob = await r.blob();
        const reader = new FileReader();
        return await new Promise(resolve => {
            reader.onload = () => resolve({ ok: true, dataUrl: reader.result, timestamps: null });
            reader.onerror = () => resolve({ ok: false, error: 'blob read failed' });
            reader.readAsDataURL(blob);
        });
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

async function findYouTubeTab() {
    const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
    return tabs[0] || null;
}

// Runs in MAIN world inside the YouTube tab.
// Has access to ytcfg + page-cookied fetch.
async function fetchAllWatchLaterIds() {
    function getCfg(key) {
        try { return window.ytcfg?.get?.(key); } catch { return null; }
    }
    const ctx = getCfg('INNERTUBE_CONTEXT');
    const key = getCfg('INNERTUBE_API_KEY');
    if (!ctx || !key) {
        return { ok: false, reason: 'ytcfg-missing' };
    }

    const ORIGIN = 'https://www.youtube.com';

    function getSapisid() {
        const m = document.cookie.match(/(?:^|;\s*)(?:SAPISID|__Secure-3PAPISID)=([^;]+)/);
        return m ? m[1] : null;
    }

    async function sapisidHash() {
        const sapisid = getSapisid();
        if (!sapisid) return null;
        const ts = Math.floor(Date.now() / 1000);
        const data = `${ts} ${sapisid} ${ORIGIN}`;
        const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(data));
        const hex = Array.from(new Uint8Array(buf))
            .map(b => b.toString(16).padStart(2, '0')).join('');
        return `SAPISIDHASH ${ts}_${hex}`;
    }

    const auth = await sapisidHash();
    if (!auth) {
        return { ok: false, reason: 'no-sapisid-cookie' };
    }

    // Active account index — YouTube uses SESSION_INDEX in ytcfg, or read from URL/header
    const sessionIndex =
        getCfg('SESSION_INDEX') ??
        ctx?.client?.sessionIndex ??
        '0';

    // DELEGATED_SESSION_ID is set when using a delegated/branded account
    const delegatedSessionId = getCfg('DELEGATED_SESSION_ID');

    const ids = new Set();
    const url = `/youtubei/v1/browse?key=${encodeURIComponent(key)}&prettyPrint=false`;
    const baseHeaders = {
        'Content-Type': 'application/json',
        'Authorization': auth,
        'X-Origin': ORIGIN,
        'X-Goog-AuthUser': String(sessionIndex),
    };
    if (delegatedSessionId) {
        baseHeaders['X-Goog-PageId'] = delegatedSessionId;
    }
    const debug = {
        sessionIndex: String(sessionIndex),
        delegatedSessionId: delegatedSessionId || null,
        pages: 0,
        firstPageCount: 0,
        gotInitialToken: false,
        continuationCounts: [],
    };

    // Recursively walk any object/array, collect videoIds + last continuation token.
    function harvest(node, out) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
            for (const v of node) harvest(v, out);
            return;
        }
        const vid = node?.playlistVideoRenderer?.videoId;
        if (vid) ids.add(vid);
        const tok = node?.continuationItemRenderer?.continuationEndpoint
                     ?.continuationCommand?.token;
        if (tok) out.token = tok;
        for (const k in node) harvest(node[k], out);
    }

    async function post(body) {
        const r = await fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: baseHeaders,
            body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error('http-' + r.status);
        return r.json();
    }

    let data;
    try {
        data = await post({ context: ctx, browseId: 'VLWL' });
    } catch (e) {
        return { ok: false, reason: 'initial-' + e.message };
    }

    if (data?.alerts?.[0]?.alertRenderer?.text?.simpleText?.toLowerCase?.().includes('sign')) {
        return { ok: false, reason: 'not-signed-in' };
    }

    const out = { token: null };
    const beforeSize = ids.size;
    harvest(data, out);
    debug.firstPageCount = ids.size;
    debug.gotInitialToken = !!out.token;
    debug.pages = 1;
    if (ids.size === beforeSize) {
        // Diagnostic: collect all *Renderer keys seen in tree
        const rendererTally = {};
        function tallyRenderers(node) {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node)) { node.forEach(tallyRenderers); return; }
            for (const k in node) {
                if (k.endsWith('Renderer')) {
                    rendererTally[k] = (rendererTally[k] || 0) + 1;
                }
                tallyRenderers(node[k]);
            }
        }
        tallyRenderers(data);
        const topKeys = Object.keys(data).slice(0, 10);
        const alertText = data?.alerts?.[0]?.alertRenderer?.text?.simpleText
                       || data?.alerts?.[0]?.alertRenderer?.text?.runs?.[0]?.text;
        console.log('[Quick Block] no-videos diagnostic:', {
            topKeys,
            rendererTally,
            alertText,
            url,
            ctxClientName: ctx?.client?.clientName,
            ctxClientVersion: ctx?.client?.clientVersion,
            sample: JSON.stringify(data).slice(0, 800),
        });
        return {
            ok: false,
            reason: 'no-videos-in-response',
            topKeys,
            rendererTally,
            alertText,
            sample: JSON.stringify(data).slice(0, 600),
        };
    }

    let token = out.token;
    let safety = 0;
    while (token && safety++ < 50) {
        let cdata;
        try {
            cdata = await post({ context: ctx, continuation: token });
        } catch (e) {
            return { ok: false, reason: 'cont-' + e.message, partial: [...ids], debug };
        }
        const next = { token: null };
        const sizeBefore = ids.size;
        harvest(cdata, next);
        debug.pages++;
        debug.continuationCounts.push(ids.size - sizeBefore);
        if (ids.size === sizeBefore) break;
        if (next.token === token) break;
        token = next.token;
    }

    return { ok: true, ids: [...ids], debug };
}


async function triggerSync() {
    try {
        const tab = await findYouTubeTab();
        if (!tab) return { ok: false, reason: 'no-youtube-tab' };

        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: fetchAllWatchLaterIds,
        });

        if (!result || !result.ok) {
            return { ...(result || {}), ok: false, reason: result?.reason || 'no-result' };
        }

        const Storage = self.QuickBlockStorage;
        // Merge with existing — never destroy IDs we already know about.
        // Removals are caught by content-script click capture in real time.
        const existing = await Storage.getWlIds();
        const merged = new Set([...existing, ...result.ids]);
        await Storage.setWlIds(merged);
        await Storage.setLastSync(Date.now());

        chrome.tabs.sendMessage(tab.id, { type: 'rescan' }).catch(() => {});

        return {
            ok: true,
            count: merged.size,
            fetched: result.ids.length,
            added: merged.size - existing.size,
            debug: result.debug,
        };
    } catch (e) {
        console.warn('[Quick Block] sync failed:', e);
        return { ok: false, reason: String(e?.message || e) };
    }
}
