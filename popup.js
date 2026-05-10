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
        showToast(`Synced ${result.count ?? ''} videos`);
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

$('#clearBtn').addEventListener('click', async () => {
    if (!confirm('Clear all stored data (Watch Later list, history, settings)?')) return;
    await Storage.clearAll();
    showToast('Cleared');
    render();
});

chrome.storage.onChanged.addListener(() => render());

render();
