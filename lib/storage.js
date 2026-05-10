// Shared storage wrapper. Set-backed for O(1) lookups.
// Schema:
//   wlIds: string[]            video IDs in Watch Later
//   recentHidden: {id,title,ts}[]  last 20 hidden, newest first
//   hiddenToday: { date: 'YYYY-MM-DD', count: number }
//   sessionRestored: not persisted (lives in content.js)
//   settings: { hideEnabled: boolean }
//   lastSyncTs: number | null

const KEYS = {
    WL_IDS: 'wlIds',
    RECENT: 'recentHidden',
    TODAY: 'hiddenToday',
    SETTINGS: 'settings',
    LAST_SYNC: 'lastSyncTs',
};

const DEFAULT_SETTINGS = {
    hideEnabled: true,
    autoFullscreen: false,
    autoOpenComments: false,
    hideBottomComments: false,
    hideShareButton: false,
    hideThanksButton: false,
};

async function getAll() {
    return await chrome.storage.local.get(Object.values(KEYS));
}

async function getWlIds() {
    const { [KEYS.WL_IDS]: ids } = await chrome.storage.local.get(KEYS.WL_IDS);
    return new Set(ids || []);
}

async function setWlIds(idSet) {
    await chrome.storage.local.set({ [KEYS.WL_IDS]: [...idSet] });
}

async function addWlId(id) {
    const set = await getWlIds();
    set.add(id);
    await setWlIds(set);
}

async function removeWlId(id) {
    const set = await getWlIds();
    set.delete(id);
    await setWlIds(set);
}

async function getSettings() {
    const { [KEYS.SETTINGS]: s } = await chrome.storage.local.get(KEYS.SETTINGS);
    return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

async function setSettings(patch) {
    const current = await getSettings();
    await chrome.storage.local.set({ [KEYS.SETTINGS]: { ...current, ...patch } });
}

async function getLastSync() {
    const { [KEYS.LAST_SYNC]: ts } = await chrome.storage.local.get(KEYS.LAST_SYNC);
    return ts || null;
}

async function setLastSync(ts) {
    await chrome.storage.local.set({ [KEYS.LAST_SYNC]: ts });
}

async function logHidden(id, title) {
    const today = new Date().toISOString().slice(0, 10);
    const { [KEYS.RECENT]: recent, [KEYS.TODAY]: todayRec } =
        await chrome.storage.local.get([KEYS.RECENT, KEYS.TODAY]);

    const list = recent || [];
    if (!list.some(e => e.id === id)) {
        list.unshift({ id, title, ts: Date.now() });
        if (list.length > 20) list.length = 20;
    }

    let count = 0;
    if (todayRec && todayRec.date === today) count = todayRec.count;
    count += 1;

    await chrome.storage.local.set({
        [KEYS.RECENT]: list,
        [KEYS.TODAY]: { date: today, count },
    });
}

async function getRecent() {
    const { [KEYS.RECENT]: recent } = await chrome.storage.local.get(KEYS.RECENT);
    return recent || [];
}

async function getTodayCount() {
    const today = new Date().toISOString().slice(0, 10);
    const { [KEYS.TODAY]: rec } = await chrome.storage.local.get(KEYS.TODAY);
    if (rec && rec.date === today) return rec.count;
    return 0;
}

async function clearAll() {
    await chrome.storage.local.clear();
}

// Expose to other scripts (content/background/popup all import via <script>)
self.QuickBlockStorage = {
    KEYS,
    getAll,
    getWlIds, setWlIds, addWlId, removeWlId,
    getSettings, setSettings,
    getLastSync, setLastSync,
    logHidden, getRecent, getTodayCount,
    clearAll,
};
