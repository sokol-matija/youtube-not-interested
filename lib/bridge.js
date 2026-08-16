// Bridge port resolver. Probes candidate ports, caches the live one in
// chrome.storage.local so we don't reprobe on every call. Mac runs the bridge
// on 7779 (VoiceMode squats 7777); Windows leaves it on 7777.

(function () {
    const CANDIDATE_PORTS = [7777, 7779];
    const HEALTH_TIMEOUT_MS = 800;
    const STORAGE_KEY = 'bridgePort';

    let activePort = null;
    let inFlight = null;

    async function probe(port) {
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
            const res = await fetch(`http://localhost:${port}/health`, { signal: ctrl.signal });
            clearTimeout(t);
            return res.ok;
        } catch {
            return false;
        }
    }

    async function getCached() {
        try {
            const { [STORAGE_KEY]: p } = await chrome.storage.local.get(STORAGE_KEY);
            return CANDIDATE_PORTS.includes(p) ? p : null;
        } catch {
            return null;
        }
    }

    async function setCached(port) {
        try { await chrome.storage.local.set({ [STORAGE_KEY]: port }); } catch {}
    }

    async function discover() {
        const cached = await getCached();
        if (cached && await probe(cached)) return cached;

        // Race remaining candidates; first ok wins.
        const others = CANDIDATE_PORTS.filter(p => p !== cached);
        for (const p of others) {
            if (await probe(p)) {
                await setCached(p);
                return p;
            }
        }
        return null;
    }

    async function resolvePort({ forceRefresh = false } = {}) {
        if (activePort && !forceRefresh) return activePort;
        if (inFlight) return inFlight;
        inFlight = discover().finally(() => { inFlight = null; });
        const p = await inFlight;
        if (p) activePort = p;
        return p;
    }

    async function bridgeUrl(path) {
        const port = await resolvePort();
        if (!port) throw new Error('Bridge unreachable on ports ' + CANDIDATE_PORTS.join(', '));
        return `http://localhost:${port}${path}`;
    }

    function invalidate() { activePort = null; }

    // ── Phone sync ──────────────────────────────────────────────────────────
    // File a finished summary with the always-on Windows bridge so it appears in
    // the phone app's history. Deliberately NOT the locally-resolved port: on the
    // Mac that is the Mac's own bridge, and the phone reads from Windows.
    // Storage key for the sync token, shared with the options page. The token
    // itself is read in background.js, where the request is actually made — and
    // never hardcoded, since an earlier revision did exactly that and the commit
    // went to a public repo. Set it in Options → Phone sync token.
    const SYNC_TOKEN_KEY = 'bridgeSyncToken';

    /**
     * Best-effort — a summary is already rendered and cached locally by the time
     * this runs, so a failure here must never surface to the user or break the
     * drawer. The phone simply won't have that one.
     */
    async function syncSummary(payload) {
        try {
            // Handed to the service worker rather than fetched here: this code runs
            // in a content script on an https:// page, and Chrome blocks plain
            // http:// requests to a remote host as mixed content. See background.js.
            const res = await chrome.runtime.sendMessage({ type: 'sync-summary', payload });
            return !!res?.ok;
        } catch {
            return false;
        }
    }

    const api = { resolvePort, bridgeUrl, invalidate, syncSummary, SYNC_TOKEN_KEY, CANDIDATE_PORTS };
    if (typeof self !== 'undefined') self.QuickBlockBridge = api;
})();
