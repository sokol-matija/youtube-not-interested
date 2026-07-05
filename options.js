const Storage = self.QuickBlockStorage;
const $ = (sel) => document.querySelector(sel);

// ── Version ───────────────────────────────────────────────────────────────────

const manifest = chrome.runtime.getManifest();
$('#appVersion').textContent = `v${manifest.version}`;

// ── Sidebar navigation ────────────────────────────────────────────────────────

document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('panel-' + btn.dataset.panel).classList.add('active');
    });
});

// ── Toast ─────────────────────────────────────────────────────────────────────

function showToast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 1800);
}

// ── Summary profiles ──────────────────────────────────────────────────────────

async function loadProfiles() {
    const [profiles, settings] = await Promise.all([
        Storage.getSummaryProfiles(),
        Storage.getSettings(),
    ]);
    const activeId = settings.activeSummaryProfileId || 'standard';
    const sel = $('#summaryProfileSelect');
    sel.innerHTML = '';
    for (const p of profiles) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        if (p.id === activeId) opt.selected = true;
        sel.appendChild(opt);
    }
    renderProfileEditor(profiles, activeId);
}

function renderProfileEditor(profiles, activeId) {
    const profile = profiles.find(p => p.id === activeId) || profiles[0];
    if (!profile) return;
    $('#profileNameInput').value = profile.name;
    $('#profileNameInput').disabled = !!profile.builtin;
    $('#profilePromptText').value = profile.prompt;
    $('#deleteProfileBtn').disabled = !!profile.builtin;
}

$('#summaryProfileSelect').addEventListener('change', async (e) => {
    const newId = e.target.value;
    await Storage.setSettings({ activeSummaryProfileId: newId });
    const profiles = await Storage.getSummaryProfiles();
    renderProfileEditor(profiles, newId);
});

$('#saveProfileBtn').addEventListener('click', async () => {
    const activeId = $('#summaryProfileSelect').value;
    const profiles = await Storage.getSummaryProfiles();
    const idx = profiles.findIndex(p => p.id === activeId);
    if (idx === -1) return;
    const updated = { ...profiles[idx] };
    const newPrompt = $('#profilePromptText').value.trim();
    if (!newPrompt) { showToast('Prompt cannot be empty'); return; }
    updated.prompt = newPrompt;
    if (!updated.builtin) {
        const newName = $('#profileNameInput').value.trim();
        if (newName) updated.name = newName;
    }
    profiles[idx] = updated;
    await Storage.setSummaryProfiles(profiles);
    showToast('Profile saved');
    await loadProfiles();
});

$('#deleteProfileBtn').addEventListener('click', async () => {
    const activeId = $('#summaryProfileSelect').value;
    const profiles = await Storage.getSummaryProfiles();
    const profile = profiles.find(p => p.id === activeId);
    if (!profile || profile.builtin) return;
    if (!confirm(`Delete profile "${profile.name}"?`)) return;
    const updated = profiles.filter(p => p.id !== activeId);
    await Storage.setSummaryProfiles(updated);
    await Storage.setSettings({ activeSummaryProfileId: 'standard' });
    showToast('Profile deleted');
    await loadProfiles();
});

$('#newProfileBtn').addEventListener('click', async () => {
    const profiles = await Storage.getSummaryProfiles();
    const id = 'custom-' + Date.now();
    profiles.push({
        id,
        name: 'Custom',
        builtin: false,
        prompt: [
            'Summarize this video.',
            '',
            'Title: {{title}}',
            '',
            'Transcript:',
            '{{transcript}}',
        ].join('\n'),
    });
    await Storage.setSummaryProfiles(profiles);
    await Storage.setSettings({ activeSummaryProfileId: id });
    showToast('New profile created — edit and save');
    await loadProfiles();
});

// ── Render ────────────────────────────────────────────────────────────────────

function fmtRelative(ts) {
    if (!ts) return 'Never synced';
    const diff = Date.now() - ts;
    const s = Math.floor(diff / 1000);
    if (s < 60) return 'Synced just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `Synced ${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `Synced ${h}h ago`;
    return `Synced ${Math.floor(h / 24)}d ago`;
}

async function render() {
    const [{ size: wlCount }, settings, lastSync, today, recent] = await Promise.all([
        Storage.getWlIds().then(s => ({ size: s.size })),
        Storage.getSettings(),
        Storage.getLastSync(),
        Storage.getTodayCount(),
        Storage.getRecent(),
    ]);

    $('#hiddenToday').textContent = today;
    $('#wlCount').textContent = wlCount;
    $('#wlCountSync').textContent = wlCount;
    $('#syncWhen').textContent = fmtRelative(lastSync);

    $('#hideToggle').checked             = settings.hideEnabled !== false;
    $('#autoFsToggle').checked           = !!settings.autoFullscreen;
    $('#autoCommentsToggle').checked     = !!settings.autoOpenComments;
    $('#hideBottomCommentsToggle').checked = !!settings.hideBottomComments;
    $('#hideShareToggle').checked        = !!settings.hideShareButton;
    $('#hideThanksToggle').checked       = !!settings.hideThanksButton;
    $('#hideSearchOnWatchToggle').checked = !!settings.hideSearchOnWatch;
    $('#cinemaModeToggle').checked       = !!settings.cinemaMode;
    $('#hideDescriptionToggle').checked  = !!settings.hideDescription;
    $('#hideTeaserCarouselToggle').checked = !!settings.hideTeaserCarousel;
    $('#autoSummarizeToggle').checked    = !!settings.autoSummarize;
    $('#autoSummarizeSilentToggle').checked = !!settings.autoSummarizeSilent;
    $('#autoTtsToggle').checked          = !!settings.autoTts;
    $('#karaokeToggle').checked          = settings.karaokeEnabled !== false;
    $('#karaokeWordCountSelect').value   = String(settings.karaokeWordCount || 3);
    $('#modelSelect').value              = settings.claudeModel || 'sonnet';
    $('#diagModelSelect').value          = settings.claudeModel || 'sonnet';

    // Scheduled Focus Mode
    $('#focusHideNowToggle').checked = !!settings.focusHideNow;
    $('#focusEnabledToggle').checked = !!settings.focusModeEnabled;
    $('#focusStart').value = settings.focusStart || '09:00';
    $('#focusEnd').value   = settings.focusEnd || '17:00';
    if (document.activeElement !== $('#focusMessage')) {
        $('#focusMessage').value = settings.focusMessage ?? 'You are free, do something that matters';
    }
    $('#focusBeamToggle').checked = settings.focusBeam !== false;
    const focusDays = new Set(Array.isArray(settings.focusDays) ? settings.focusDays : []);
    document.querySelectorAll('#focusDays .focus-day').forEach(b =>
        b.classList.toggle('active', focusDays.has(+b.dataset.day)));
    // While the schedule is on, lock days + times — editing them would dodge the
    // window. To change them, turn the schedule off first (password-gated).
    setFocusControlsLocked(!!settings.focusModeEnabled);
    renderFocusStatus();

    await loadProfiles();

    const list = $('#recentList');
    list.innerHTML = '';
    if (recent.length === 0) {
        const li = document.createElement('li');
        li.className = 'empty';
        li.textContent = 'Nothing hidden yet.';
        list.appendChild(li);
    } else {
        for (const entry of recent) {
            const li = document.createElement('li');
            const title = document.createElement('span');
            title.className = 'title';
            title.textContent = entry.title || entry.id;
            title.title = entry.title || entry.id;
            const btn = document.createElement('button');
            btn.className = 'undo';
            btn.textContent = 'undo';
            btn.addEventListener('click', () => undoOne(entry.id));
            li.appendChild(title);
            li.appendChild(btn);
            list.appendChild(li);
        }
    }
}

async function undoOne(id) {
    const set = await Storage.getWlIds();
    set.delete(id);
    await Storage.setWlIds(set);
    const recent = await Storage.getRecent();
    await chrome.storage.local.set({
        [Storage.KEYS.RECENT]: recent.filter(e => e.id !== id),
    });
    showToast('Removed — reload page to see');
    render();
}

// ── Toggle listeners ──────────────────────────────────────────────────────────

$('#hideToggle').addEventListener('change', e => Storage.setSettings({ hideEnabled: e.target.checked }));
$('#autoFsToggle').addEventListener('change', e => Storage.setSettings({ autoFullscreen: e.target.checked }));
$('#autoCommentsToggle').addEventListener('change', e => Storage.setSettings({ autoOpenComments: e.target.checked }));
$('#hideBottomCommentsToggle').addEventListener('change', e => Storage.setSettings({ hideBottomComments: e.target.checked }));
$('#hideShareToggle').addEventListener('change', e => Storage.setSettings({ hideShareButton: e.target.checked }));
$('#hideThanksToggle').addEventListener('change', e => Storage.setSettings({ hideThanksButton: e.target.checked }));
$('#hideSearchOnWatchToggle').addEventListener('change', e => Storage.setSettings({ hideSearchOnWatch: e.target.checked }));
$('#cinemaModeToggle').addEventListener('change', e => Storage.setSettings({ cinemaMode: e.target.checked }));
$('#hideDescriptionToggle').addEventListener('change', e => Storage.setSettings({ hideDescription: e.target.checked }));
$('#hideTeaserCarouselToggle').addEventListener('change', e => Storage.setSettings({ hideTeaserCarousel: e.target.checked }));
$('#autoSummarizeToggle').addEventListener('change', e => Storage.setSettings({ autoSummarize: e.target.checked }));
$('#autoSummarizeSilentToggle').addEventListener('change', e => Storage.setSettings({ autoSummarizeSilent: e.target.checked }));
$('#autoTtsToggle').addEventListener('change', e => Storage.setSettings({ autoTts: e.target.checked }));
$('#karaokeToggle').addEventListener('change', e => Storage.setSettings({ karaokeEnabled: e.target.checked }));
$('#karaokeWordCountSelect').addEventListener('change', e => Storage.setSettings({ karaokeWordCount: parseInt(e.target.value, 10) || 3 }));
$('#modelSelect').addEventListener('change', e => Storage.setSettings({ claudeModel: e.target.value }));
$('#diagModelSelect').addEventListener('change', e => {
    Storage.setSettings({ claudeModel: e.target.value });
    $('#modelSelect').value = e.target.value;
});

// ── Scheduled Focus Mode ────────────────────────────────────────────────────────
// Same rule as content.js isInFocusWindow, computed from the live controls so the
// status flips instantly as you edit days/times — no guessing whether it's "on now".
function focusActiveNow() {
    if (!$('#focusEnabledToggle').checked) return false;
    const days = [...document.querySelectorAll('#focusDays .focus-day.active')].map(b => +b.dataset.day);
    if (!days.length) return false;
    const toMin = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ''); return m ? +m[1] * 60 + +m[2] : null; };
    const s = toMin($('#focusStart').value), e = toMin($('#focusEnd').value);
    if (s === null || e === null || s === e) return false;
    const now = new Date(), cur = now.getHours() * 60 + now.getMinutes(), today = now.getDay();
    if (s < e) return cur >= s && cur < e && days.includes(today);
    return (cur >= s && days.includes(today)) || (cur < e && days.includes((today + 6) % 7));
}
function setFocusControlsLocked(locked) {
    document.querySelectorAll('#focusDays .focus-day').forEach(b => { b.disabled = locked; });
    $('#focusStart').disabled = locked;
    $('#focusEnd').disabled = locked;
}
function renderFocusStatus() {
    const el = $('#focusStatus');
    if (!el) return;
    if ($('#focusHideNowToggle').checked) {
        el.textContent = '● Hidden now (manual override)';
        el.className = 'focus-status active';
    } else if (!$('#focusEnabledToggle').checked) {
        el.textContent = 'Schedule off';
        el.className = 'focus-status';
    } else if (focusActiveNow()) {
        el.textContent = '● Active now — homepage hidden';
        el.className = 'focus-status active';
    } else {
        el.textContent = '○ Inactive right now';
        el.className = 'focus-status';
    }
}
setInterval(renderFocusStatus, 20000);  // time passes → status can flip on its own

$('#focusHideNowToggle').addEventListener('change', e => Storage.setSettings({ focusHideNow: e.target.checked }));

// Friction (not security): turning the schedule OFF requires a deliberately
// hard password you have to recall in the moment. Enabling it stays free.
const FOCUS_UNLOCK = 'j5q8rqwp521c1';
$('#focusEnabledToggle').addEventListener('change', e => {
    if (!e.target.checked) {
        const pw = prompt('Enter password to turn OFF the focus schedule:');
        if (pw !== FOCUS_UNLOCK) {
            e.target.checked = true;  // revert — stays enabled
            if (pw !== null) showToast('Wrong password — schedule stays on');
            return;
        }
    }
    Storage.setSettings({ focusModeEnabled: e.target.checked });
});
$('#focusMessage').addEventListener('input', e => Storage.setSettings({ focusMessage: e.target.value }));
$('#focusBeamToggle').addEventListener('change', e => Storage.setSettings({ focusBeam: e.target.checked }));
$('#focusStart').addEventListener('change', e => Storage.setSettings({ focusStart: e.target.value || '09:00' }));
$('#focusEnd').addEventListener('change', e => Storage.setSettings({ focusEnd: e.target.value || '17:00' }));
document.querySelectorAll('#focusDays .focus-day').forEach(btn => {
    btn.addEventListener('click', async () => {
        btn.classList.toggle('active');
        const days = [...document.querySelectorAll('#focusDays .focus-day.active')]
            .map(b => +b.dataset.day).sort((a, b) => a - b);
        await Storage.setSettings({ focusDays: days });
    });
});

// ── Sync ──────────────────────────────────────────────────────────────────────

$('#syncBtn').addEventListener('click', async () => {
    const btn = $('#syncBtn');
    btn.disabled = true;
    btn.textContent = 'Syncing…';
    const result = await chrome.runtime.sendMessage({ type: 'request-sync' });
    btn.disabled = false;
    btn.textContent = 'Sync now';
    if (!result?.ok) {
        const reason = result?.reason || 'unknown';
        if (reason === 'no-youtube-tab') showToast('Open a YouTube tab first');
        else if (reason === 'not-signed-in') showToast('Sign in to YouTube first');
        else showToast(`Sync failed: ${reason}`);
    } else {
        showToast(`Synced ${result.fetched ?? result.count} (+${result.added ?? 0} new)`);
    }
    render();
});

// ── Import ────────────────────────────────────────────────────────────────────

$('#importBtn').addEventListener('click', async () => {
    const text = $('#importText').value;
    const merge = $('#importMerge').checked;
    const ids = (text.match(/[a-zA-Z0-9_-]{11}/g) || []);
    if (ids.length === 0) { showToast('No valid IDs found'); return; }
    const target = merge ? await Storage.getWlIds() : new Set();
    ids.forEach(id => target.add(id));
    await Storage.setWlIds(target);
    await Storage.setLastSync(Date.now());
    $('#importText').value = '';
    showToast(`Imported ${ids.length} IDs (total ${target.size})`);
    render();
});

// ── Clear ─────────────────────────────────────────────────────────────────────

$('#clearBtn').addEventListener('click', async () => {
    if (!confirm('Clear all stored data (Watch Later list, history, settings)?')) return;
    await Storage.clearAll();
    showToast('Cleared');
    render();
});

// ── Bridge health ─────────────────────────────────────────────────────────────

async function pingBridge() {
    const dot = $('#healthDot');
    const status = $('#healthStatus');
    dot.classList.remove('ok', 'fail');
    status.textContent = 'checking…';
    self.QuickBlockBridge.invalidate();
    const t0 = Date.now();
    try {
        const url = await self.QuickBlockBridge.bridgeUrl('/health');
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 1500);
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timeout);
        const ms = Date.now() - t0;
        if (res.ok) {
            const data = await res.json().catch(() => ({}));
            dot.classList.add('ok');
            const model = data.defaultModel ? ` · ${data.defaultModel}` : '';
            const port = data.port ? ` :${data.port}` : '';
            status.textContent = `online${port} · ${ms}ms${model}`;
        } else {
            dot.classList.add('fail');
            status.textContent = `HTTP ${res.status}`;
        }
    } catch (e) {
        dot.classList.add('fail');
        status.textContent = e.name === 'AbortError' ? 'timeout' : 'offline';
    }
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

$('#transcriptTestBtn').addEventListener('click', async () => {
    const btn = $('#transcriptTestBtn');
    const out = $('#claudeTestOut');
    const copyBtn = $('#claudeCopyBtn');
    btn.disabled = true;
    btn.textContent = 'Fetching…';
    out.hidden = false;
    out.textContent = '…';
    copyBtn.hidden = true;
    try {
        const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/watch*', active: true, currentWindow: true });
        const tab = tabs[0] || (await chrome.tabs.query({ url: '*://*.youtube.com/watch*' }))[0];
        if (!tab?.url) { out.textContent = 'No YouTube watch tab open.'; return; }
        const videoId = new URL(tab.url).searchParams.get('v');
        if (!videoId) { out.textContent = 'Could not parse videoId.'; return; }
        const r = await fetch(await self.QuickBlockBridge.bridgeUrl('/transcript'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videoId }),
        });
        const data = await r.json();
        if (!data.ok) { out.textContent = `FAILED: ${data.reason || 'unknown'}\n${data.message || ''}`; return; }
        const text = `VideoId: ${videoId}\nLanguage: ${data.language}${data.isAsr ? ' (auto)' : ''}\nSegments: ${data.segments.length}\n\n` +
            data.segments.map(s => {
                const sec = Math.floor(s.t / 1000);
                return `[${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}] ${s.text}`;
            }).join('\n');
        out.dataset.raw = text;
        out.textContent = `OK — ${data.segments.length} segments (${data.elapsedMs}ms)\n\n` + text.split('\n').slice(4,9).join('\n');
        copyBtn.hidden = false;
        copyBtn.textContent = 'Copy full transcript';
    } catch (e) {
        out.textContent = `Error: ${e.message}`;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Test transcript → clipboard';
    }
});

$('#claudeTestBtn').addEventListener('click', async () => {
    const btn = $('#claudeTestBtn');
    const out = $('#claudeTestOut');
    const copyBtn = $('#claudeCopyBtn');
    const model = $('#diagModelSelect').value;
    btn.disabled = true;
    btn.textContent = 'Asking…';
    out.hidden = false;
    out.textContent = '…';
    copyBtn.hidden = true;
    try {
        const t0 = Date.now();
        const res = await fetch(await self.QuickBlockBridge.bridgeUrl('/run'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: "What is today's date? Answer in YYYY-MM-DD only.", model }),
        });
        const data = await res.json();
        if (data.ok) {
            out.textContent = `${data.output}\n\n(${model} · ${Math.round((Date.now()-t0)/100)/10}s)`;
            out.dataset.raw = data.output;
            copyBtn.hidden = false;
            copyBtn.textContent = 'Copy output';
        } else {
            out.textContent = `Error: ${data.error}`;
        }
    } catch (e) {
        out.textContent = `Bridge unreachable.\n\n${e.message}`;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Test Claude: what\'s today\'s date?';
    }
});

$('#claudeCopyBtn').addEventListener('click', async () => {
    const out = $('#claudeTestOut');
    try {
        await navigator.clipboard.writeText(out.dataset.raw || out.textContent);
        const btn = $('#claudeCopyBtn');
        const orig = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = orig; }, 1200);
    } catch { showToast('Copy failed'); }
});

// ── Boot ──────────────────────────────────────────────────────────────────────

chrome.storage.onChanged.addListener(() => render());
render();
pingBridge();
