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
    SUMMARIES: 'summaries',
    SUMMARY_PROFILES: 'summaryProfiles',
    TTS_AUDIO: 'ttsAudio',
};

const DEFAULT_SUMMARY_PROFILES = [
    {
        id: 'standard',
        name: 'Standard',
        builtin: true,
        prompt: [
            `You are a skilled content analyst. Summarize this video transcript. No preamble — start directly with content.`,
            ``,
            `Skip all YouTube filler: intro greetings, subscribe/like prompts, sponsor reads.`,
            `Only use information from the transcript. Scale depth to the {{duration}} runtime.`,
            ``,
            `What it's about: [1–2 sentences]`,
            `Key points: [3–5 items in order, each 1–2 sentences, fewer for shorter videos]`,
            `Notable insights: [any surprising or valuable observations — omit if none]`,
            `Verdict: [1 sentence — what's the main takeaway or conclusion]`,
            ``,
            `Title: {{title}} | Runtime: {{duration}}`,
            ``,
            `<transcript>`,
            `{{transcript}}`,
            `</transcript>`,
        ].join('\n'),
    },
    {
        id: 'podcast-tts',
        name: 'Podcast (TTS)',
        builtin: true,
        prompt: [
            `You are a skilled radio journalist writing a spoken recap for listeners. Your writing sounds completely natural when read aloud.`,
            ``,
            `Rules you must follow:`,
            `- Flowing conversational prose only. No bullet points, no markdown, no headers, no numbered lists.`,
            `- Sentences under 15 words. One idea per sentence.`,
            `- Use contractions: it's, you'll, they've, there's, don't.`,
            `- Active voice: "The host argues X" not "X is argued by the host."`,
            `- Scale strictly to runtime: roughly one short paragraph per five minutes. A {{duration}} video gets proportional length.`,
            `- Lead with the most interesting or important point — not the beginning of the video.`,
            `- Skip YouTube intros, subscribe prompts, and sponsor reads.`,
            `- Only use information from the transcript.`,
            `- Do not start with "This video" or "In this video."`,
            ``,
            `Title: {{title}} | Runtime: {{duration}}`,
            ``,
            `<transcript>`,
            `{{transcript}}`,
            `</transcript>`,
        ].join('\n'),
    },
    {
        id: 'quick',
        name: 'Quick Take',
        builtin: true,
        prompt: [
            `You are a ruthless editor. Read this transcript and answer in 3–4 sentences of plain prose:`,
            `What is this video actually about? What's the single most important thing it says? Is there enough substance here to be worth watching?`,
            ``,
            `No preamble. No bullets. No markdown. Skip intros, subscribe calls, sponsors.`,
            `Start your answer directly. Only use information from the transcript.`,
            ``,
            `Title: {{title}} | Runtime: {{duration}}`,
            ``,
            `<transcript>`,
            `{{transcript}}`,
            `</transcript>`,
        ].join('\n'),
    },
    {
        id: 'deep-study',
        name: 'Deep Study',
        builtin: true,
        prompt: [
            `You are an expert content analyst summarizing educational or technical video content.`,
            `Create a thorough summary for someone who wants to fully understand the material without re-watching.`,
            ``,
            `Write in clear prose paragraphs. No bullet points, no markdown headers.`,
            `Scale depth to the {{duration}} runtime — longer videos deserve more thorough coverage.`,
            ``,
            `Cover in this order:`,
            `First, state the core premise or central argument in 2–3 sentences.`,
            `Then walk through the main ideas in the order they appear, giving each enough explanation to stand alone.`,
            `Note any key frameworks, models, concepts, or techniques introduced.`,
            `Close with the main conclusion or takeaway and any action it implies.`,
            ``,
            `Skip YouTube filler: intros, subscribe prompts, sponsor reads.`,
            `Only use information from the transcript.`,
            ``,
            `Title: {{title}} | Runtime: {{duration}}`,
            ``,
            `<transcript>`,
            `{{transcript}}`,
            `</transcript>`,
        ].join('\n'),
    },
    {
        id: 'classic',
        name: 'Classic',
        builtin: true,
        prompt: [
            `Here is a transcript from a ~20-minute video/podcast. Summarize it with:`,
            ``,
            `What it's about (2–3 sentences)`,
            `Main points covered (in order, as bullets)`,
            `Key insights, opinions, or recommendations worth remembering`,
            `Verdict or conclusion (if one is given)`,
            ``,
            `Be thorough but concise — I want the full value without watching/listening.`,
            ``,
            `Title: {{title}}`,
            ``,
            `Transcript:`,
            `{{transcript}}`,
        ].join('\n'),
    },
    {
        id: 'briefing',
        name: 'Briefing',
        builtin: true,
        prompt: [
            `You are writing a spoken executive briefing — a short audio summary someone will hear while walking or driving.`,
            ``,
            `Write exactly this structure as flowing prose. No markdown, no bullets, no headers:`,
            ``,
            `Open with the bottom line in one sentence — the single most important thing about this video.`,
            `Then give two or three supporting points. Each as its own short sentence. Keep each under 12 words.`,
            `Close with one sentence on the implication or what to do with this information.`,
            ``,
            `Total length: under 100 words regardless of runtime. Dense with meaning. Easy to follow when heard once.`,
            ``,
            `Do not start with "This video." Skip intros, sponsors, subscribe calls.`,
            `Only use information from the transcript.`,
            ``,
            `Title: {{title}} | Runtime: {{duration}}`,
            ``,
            `<transcript>`,
            `{{transcript}}`,
            `</transcript>`,
        ].join('\n'),
    },
];

const SUMMARY_CACHE_CAP = 50;
const TTS_AUDIO_CAP = 5;
const TTS_AUDIO_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

const DEFAULT_SETTINGS = {
    hideEnabled: true,
    autoFullscreen: false,
    autoOpenComments: false,
    hideBottomComments: false,
    hideShareButton: false,
    hideThanksButton: false,
    hideSearchOnWatch: false,
    claudeModel: 'sonnet',
    autoSummarize: false,
    activeSummaryProfileId: 'standard',
    karaokeEnabled: true,
    karaokeWordCount: 3,
    autoTts: false,
    // Scheduled Focus Mode — blank the homepage feed during a schedule.
    focusModeEnabled: false,        // master on/off (scheduled)
    focusHideNow: false,            // manual override: hide home feed now, ignore schedule
    focusDays: [1, 2, 3, 4, 5],     // 0=Sun..6=Sat (matches Date.getDay()); default weekdays
    focusStart: '09:00',            // HH:MM 24h local — pairs with <input type="time">
    focusEnd: '17:00',
    focusMessage: 'You are free, do something that matters',
    focusBeam: true,                // border-beam animation on the focus pill
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

async function getSummary(videoId) {
    if (!videoId) return null;
    const { [KEYS.SUMMARIES]: map } = await chrome.storage.local.get(KEYS.SUMMARIES);
    return map?.[videoId] || null;
}

async function setSummary(videoId, entry) {
    if (!videoId || !entry) return;
    const { [KEYS.SUMMARIES]: existing } = await chrome.storage.local.get(KEYS.SUMMARIES);
    const map = existing || {};
    map[videoId] = entry;

    // LRU trim: drop oldest by ts when over cap.
    const ids = Object.keys(map);
    if (ids.length > SUMMARY_CACHE_CAP) {
        const sorted = ids
            .map(id => ({ id, ts: map[id].ts || 0 }))
            .sort((a, b) => a.ts - b.ts);
        const dropCount = ids.length - SUMMARY_CACHE_CAP;
        for (let i = 0; i < dropCount; i++) delete map[sorted[i].id];
    }

    await chrome.storage.local.set({ [KEYS.SUMMARIES]: map });
}

async function getSummaryProfiles() {
    const { [KEYS.SUMMARY_PROFILES]: stored } = await chrome.storage.local.get(KEYS.SUMMARY_PROFILES);
    if (!stored || !stored.length) return DEFAULT_SUMMARY_PROFILES;
    // Merge: ensure builtin profiles are always present (in case new builtins added)
    const storedIds = new Set(stored.map(p => p.id));
    const missing = DEFAULT_SUMMARY_PROFILES.filter(p => p.builtin && !storedIds.has(p.id));
    return [...missing, ...stored];
}

async function setSummaryProfiles(profiles) {
    await chrome.storage.local.set({ [KEYS.SUMMARY_PROFILES]: profiles });
}

async function getTtsAudio(videoId) {
    if (!videoId) return null;
    const { [KEYS.TTS_AUDIO]: map } = await chrome.storage.local.get(KEYS.TTS_AUDIO);
    const entry = map?.[videoId];
    if (!entry) return null;
    if (Date.now() - entry.ts > TTS_AUDIO_TTL_MS) {
        // Expired — prune lazily
        const updated = { ...map };
        delete updated[videoId];
        await chrome.storage.local.set({ [KEYS.TTS_AUDIO]: updated });
        return null;
    }
    // Return the full entry so callers get word timestamps (karaoke) too.
    // Older cached entries predate timestamps → timestamps is null.
    return { dataUrl: entry.dataUrl, timestamps: entry.timestamps || null };
}

async function setTtsAudio(videoId, dataUrl, timestamps) {
    if (!videoId || !dataUrl) return;
    const { [KEYS.TTS_AUDIO]: existing } = await chrome.storage.local.get(KEYS.TTS_AUDIO);
    const map = existing || {};
    map[videoId] = { dataUrl, timestamps: timestamps || null, ts: Date.now() };

    // Prune expired entries
    const now = Date.now();
    for (const id of Object.keys(map)) {
        if (now - map[id].ts > TTS_AUDIO_TTL_MS) delete map[id];
    }

    // LRU cap: keep newest 5
    const ids = Object.keys(map);
    if (ids.length > TTS_AUDIO_CAP) {
        const sorted = ids
            .map(id => ({ id, ts: map[id].ts || 0 }))
            .sort((a, b) => a.ts - b.ts);
        const dropCount = ids.length - TTS_AUDIO_CAP;
        for (let i = 0; i < dropCount; i++) delete map[sorted[i].id];
    }

    await chrome.storage.local.set({ [KEYS.TTS_AUDIO]: map });
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
    getSummary, setSummary,
    getTtsAudio, setTtsAudio,
    getSummaryProfiles, setSummaryProfiles,
    clearAll,
};
