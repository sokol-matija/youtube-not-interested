const Storage = self.QuickBlockStorage;

const $ = (sel) => document.querySelector(sel);

function fmtRelative(ts) {
    if (!ts) return 'Never synced';
    const diff = Date.now() - ts;
    const s = Math.floor(diff / 1000);
    if (s < 60) return 'Synced just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `Synced ${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `Synced ${h}h ago`;
    const d = Math.floor(h / 24);
    return `Synced ${d}d ago`;
}

function showToast(msg) {
    let el = document.querySelector('.toast');
    if (!el) {
        el = document.createElement('div');
        el.className = 'toast';
        document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 1800);
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
    $('#syncWhen').textContent = fmtRelative(lastSync);
    $('#hideToggle').checked = settings.hideEnabled !== false;
    $('#autoFsToggle').checked = !!settings.autoFullscreen;
    $('#autoCommentsToggle').checked = !!settings.autoOpenComments;
    $('#hideBottomCommentsToggle').checked = !!settings.hideBottomComments;
    $('#hideShareToggle').checked = !!settings.hideShareButton;
    $('#hideThanksToggle').checked = !!settings.hideThanksButton;
    $('#hideSearchOnWatchToggle').checked = !!settings.hideSearchOnWatch;
    $('#autoReadToggle').checked = settings.autoReadSummary !== false;
    $('#modelSelect').value = settings.claudeModel || 'sonnet';

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
            btn.dataset.id = entry.id;
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
    const filtered = recent.filter(e => e.id !== id);
    await chrome.storage.local.set({ [Storage.KEYS.RECENT]: filtered });
    showToast('Removed — reload page to see');
    render();
}

$('#hideToggle').addEventListener('change', async (e) => {
    await Storage.setSettings({ hideEnabled: e.target.checked });
});

$('#autoFsToggle').addEventListener('change', async (e) => {
    await Storage.setSettings({ autoFullscreen: e.target.checked });
});

$('#autoCommentsToggle').addEventListener('change', async (e) => {
    await Storage.setSettings({ autoOpenComments: e.target.checked });
});

$('#hideBottomCommentsToggle').addEventListener('change', async (e) => {
    await Storage.setSettings({ hideBottomComments: e.target.checked });
});

$('#hideShareToggle').addEventListener('change', async (e) => {
    await Storage.setSettings({ hideShareButton: e.target.checked });
});

$('#hideThanksToggle').addEventListener('change', async (e) => {
    await Storage.setSettings({ hideThanksButton: e.target.checked });
});

$('#hideSearchOnWatchToggle').addEventListener('change', async (e) => {
    await Storage.setSettings({ hideSearchOnWatch: e.target.checked });
});

$('#autoReadToggle').addEventListener('change', async (e) => {
    await Storage.setSettings({ autoReadSummary: e.target.checked });
});

$('#syncBtn').addEventListener('click', async () => {
    const btn = $('#syncBtn');
    btn.disabled = true;
    btn.textContent = 'Syncing…';
    const result = await chrome.runtime.sendMessage({ type: 'request-sync' });
    btn.disabled = false;
    btn.textContent = 'Sync now';
    if (!result?.ok) {
        if (result?.reason === 'no-youtube-tab') {
            showToast('Open a YouTube tab first');
        } else if (result?.reason === 'not-signed-in') {
            showToast('Sign in to YouTube first');
        } else {
            console.warn('[Quick Block] === SYNC DIAGNOSTIC ===');
            console.warn('reason:', result?.reason);
            console.warn('topKeys:', JSON.stringify(result?.topKeys));
            console.warn('rendererTally:', JSON.stringify(result?.rendererTally, null, 2));
            console.warn('alertText:', result?.alertText);
            console.warn('sample:', result?.sample);
            console.warn('=======================');
            showToast(`Sync failed: ${result?.reason || 'unknown'}`);
        }
    } else {
        if (result.debug) {
            console.log('[Quick Block] sync debug:', JSON.stringify(result.debug, null, 2));
        }
        const added = result.added ?? 0;
        const fetched = result.fetched ?? result.count ?? 0;
        showToast(`Synced ${fetched} (+${added} new, total ${result.count})`);
    }
    render();
});

$('#importBtn').addEventListener('click', async () => {
    const text = $('#importText').value;
    const merge = $('#importMerge').checked;
    const ids = (text.match(/[a-zA-Z0-9_-]{11}/g) || []);
    if (ids.length === 0) {
        showToast('No valid IDs found');
        return;
    }
    const target = merge ? await Storage.getWlIds() : new Set();
    ids.forEach(id => target.add(id));
    await Storage.setWlIds(target);
    await Storage.setLastSync(Date.now());
    $('#importText').value = '';
    showToast(`Imported ${ids.length} IDs (total ${target.size})`);
    render();
});

$('#modelSelect').addEventListener('change', async (e) => {
    await Storage.setSettings({ claudeModel: e.target.value });
});

$('#transcriptTestBtn').addEventListener('click', async () => {
    const btn = $('#transcriptTestBtn');
    const out = $('#claudeTestOut');
    const copyBtn = $('#claudeCopyBtn');
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Fetching…';
    out.hidden = false;
    out.textContent = '…';
    copyBtn.hidden = true;

    try {
        const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/watch*', active: true, currentWindow: true });
        const tab = tabs[0] || (await chrome.tabs.query({ url: '*://*.youtube.com/watch*' }))[0];
        if (!tab?.url) {
            out.textContent = 'No YouTube watch tab open.';
            return;
        }
        const videoId = new URL(tab.url).searchParams.get('v');
        if (!videoId) {
            out.textContent = 'Could not parse videoId from active tab URL.';
            return;
        }

        const r = await fetch(await self.QuickBlockBridge.bridgeUrl('/transcript'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videoId }),
        });
        const data = await r.json();
        if (!data.ok) {
            out.textContent = `FAILED: ${data.reason || 'unknown'}\n${data.message || ''}`;
            return;
        }

        const text = `VideoId: ${videoId}
Language: ${data.language}${data.isAsr ? ' (auto)' : ''}
Segments: ${data.segments.length}

${data.segments.map(s => {
    const sec = Math.floor(s.t / 1000);
    const m = Math.floor(sec / 60);
    const ss = String(sec % 60).padStart(2, '0');
    return `[${m}:${ss}] ${s.text}`;
}).join('\n')}`;

        out.dataset.raw = text;
        out.textContent = `OK — ${data.segments.length} segments via bridge (${data.elapsedMs}ms)\n\nFirst 5 lines:\n` +
            text.split('\n').slice(4, 9).join('\n');
        copyBtn.hidden = false;
        copyBtn.textContent = 'Copy full transcript';
    } catch (e) {
        out.textContent = `Error: ${e.message}`;
    } finally {
        btn.disabled = false;
        btn.textContent = orig;
    }
});

$('#claudeTestBtn').addEventListener('click', async () => {
    const btn = $('#claudeTestBtn');
    const out = $('#claudeTestOut');
    const copyBtn = $('#claudeCopyBtn');
    const model = $('#modelSelect').value;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Asking…';
    out.hidden = false;
    out.textContent = '…';
    copyBtn.hidden = true;
    try {
        const t0 = Date.now();
        const res = await fetch(await self.QuickBlockBridge.bridgeUrl('/run'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt: "What is today's date? Answer in YYYY-MM-DD only.",
                model,
            }),
        });
        const data = await res.json();
        if (data.ok) {
            out.textContent = `${data.output}\n\n(${model} · ${Math.round((Date.now() - t0) / 100) / 10}s)`;
            out.dataset.raw = data.output;
            copyBtn.hidden = false;
            copyBtn.textContent = 'Copy output';
        } else {
            out.textContent = `Error: ${data.error}`;
        }
    } catch (e) {
        out.textContent = `Bridge unreachable. Start it with:\nnode scripts/claude-bridge.mjs\n\n${e.message}`;
    } finally {
        btn.disabled = false;
        btn.textContent = original;
    }
});

$('#claudeCopyBtn').addEventListener('click', async () => {
    const out = $('#claudeTestOut');
    const text = out.dataset.raw || out.textContent;
    try {
        await navigator.clipboard.writeText(text);
        const btn = $('#claudeCopyBtn');
        const orig = btn.textContent;
        btn.textContent = 'Copied ✓';
        setTimeout(() => { btn.textContent = orig; }, 1200);
    } catch {
        showToast('Copy failed');
    }
});

$('#clearBtn').addEventListener('click', async () => {
    if (!confirm('Clear all stored data (Watch Later list, history, settings)?')) return;
    await Storage.clearAll();
    showToast('Cleared');
    render();
});

async function pingBridge() {
    const dot = $('#healthDot');
    const status = $('#healthStatus');
    if (!dot || !status) return;
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

chrome.storage.onChanged.addListener(() => render());

render();
pingBridge();
