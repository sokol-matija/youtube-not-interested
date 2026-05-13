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

    const api = { resolvePort, bridgeUrl, invalidate, CANDIDATE_PORTS };
    if (typeof self !== 'undefined') self.QuickBlockBridge = api;
})();
