// Service worker. Periodic + on-demand WL sync.
// Uses chrome.scripting MAIN world to access ytcfg + cookied fetch.

importScripts('lib/storage.js');

const SYNC_ALARM = 'wl-sync';
const SYNC_PERIOD_MIN = 360;

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

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg?.type === 'request-sync') {
        triggerSync().then(sendResponse);
        return true;
    }
});

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
