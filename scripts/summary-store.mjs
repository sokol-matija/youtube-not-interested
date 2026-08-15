// Storage + prompt + notification layer for the phone summary path.
//
// One JSON file per video under data/summaries/. Deliberately uncapped: the
// extension's chrome.storage cache evicts at 50 entries (lib/storage.js
// SUMMARY_CACHE_CAP), and the whole point of this path is a durable history you
// can scroll on the phone.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

export const DATA_DIR = process.env.YT_SUMMARY_DIR || path.join(REPO_ROOT, 'data', 'summaries');
const PROFILES_PATH = path.join(REPO_ROOT, 'lib', 'summary-profiles.json');

// ── Video ID ────────────────────────────────────────────────────────────────

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Pull an 11-char video ID out of any YouTube URL shape, or out of a bare ID.
 * Android share text is often "Title\nhttps://youtu.be/ID?si=..." so we scan
 * the whole string rather than requiring it to parse as a lone URL.
 */
export function parseVideoId(input) {
    if (typeof input !== 'string') return null;
    const text = input.trim();
    if (VIDEO_ID_RE.test(text)) return text;

    // youtu.be/ID · /watch?v=ID · /shorts/ID · /live/ID · /embed/ID · /v/ID
    const patterns = [
        /youtu\.be\/([A-Za-z0-9_-]{11})/,
        /[?&]v=([A-Za-z0-9_-]{11})/,
        /\/shorts\/([A-Za-z0-9_-]{11})/,
        /\/live\/([A-Za-z0-9_-]{11})/,
        /\/embed\/([A-Za-z0-9_-]{11})/,
        /\/v\/([A-Za-z0-9_-]{11})/,
    ];
    for (const re of patterns) {
        const m = text.match(re);
        if (m) return m[1];
    }
    return null;
}

// ── Profiles ────────────────────────────────────────────────────────────────

let profileCache = null;

export function getProfiles() {
    if (!profileCache) {
        const raw = JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8'));
        profileCache = raw.profiles;
    }
    return profileCache;
}

export function getProfile(id) {
    const profiles = getProfiles();
    return profiles.find(p => p.id === id) || profiles[0];
}

/**
 * Fill {{title}} / {{duration}} / {{transcript}} placeholders.
 *
 * Uses replaceAll where content.js:1645 uses replace — the single-occurrence
 * version silently drops the second use of a placeholder, which matters here
 * because the phone lets you type an arbitrary prompt.
 */
export function renderPrompt(promptTemplate, { title, duration, transcript }) {
    return String(promptTemplate)
        .replaceAll('{{title}}', title || '')
        .replaceAll('{{duration}}', duration || '')
        .replaceAll('{{transcript}}', transcript || '');
}

/** Mirrors content.js:1631-1637 so phone and extension report runtime identically. */
export function formatDuration(totalSec) {
    const sec = Math.max(0, Math.round(totalSec));
    const min = Math.floor(sec / 60);
    const rem = sec % 60;
    if (min <= 0) return `${rem} sec`;
    return rem > 0 ? `${min} min ${rem} sec` : `${min} min`;
}

/** Transcript text exactly as the extension builds it (content.js:1629). */
export function segmentsToText(segments) {
    return (segments || []).map(s => s.text).join(' ');
}

export function durationFromSegments(segments) {
    if (!segments || !segments.length) return 0;
    return Math.round((segments[segments.length - 1].t || 0) / 1000);
}

// ── Records ─────────────────────────────────────────────────────────────────

function recordPath(videoId) {
    return path.join(DATA_DIR, `${videoId}.json`);
}

export function readRecord(videoId) {
    if (!VIDEO_ID_RE.test(videoId)) return null;
    try {
        return JSON.parse(fs.readFileSync(recordPath(videoId), 'utf8'));
    } catch {
        return null;
    }
}

export function writeRecord(rec) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // Write-then-rename so a crash mid-write can't leave a truncated record
    // that readRecord would silently treat as "missing".
    const target = recordPath(rec.videoId);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
    fs.renameSync(tmp, target);
    return rec;
}

/** Newest first. Transcript and markdown are stripped — this feeds the list screen. */
export function listRecords(limit = 200) {
    let names;
    try {
        names = fs.readdirSync(DATA_DIR).filter(n => n.endsWith('.json'));
    } catch {
        return [];
    }
    const out = [];
    for (const name of names) {
        const rec = readRecord(name.slice(0, -5));
        if (!rec) continue;
        out.push({
            videoId: rec.videoId,
            title: rec.title,
            author: rec.author,
            url: rec.url,
            ts: rec.ts,
            durationSec: rec.durationSec,
            profileId: rec.profileId,
            model: rec.model,
            status: rec.status,
            error: rec.error || null,
            versionCount: (rec.versions || []).length,
        });
    }
    out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return out.slice(0, limit);
}

// ── Title lookup ────────────────────────────────────────────────────────────

/**
 * oEmbed is a public, unauthenticated endpoint — same trust model as the
 * transcript path (no cookies, no key). Title is cosmetic, so any failure
 * falls back to the bare video ID rather than failing the job.
 */
export async function fetchTitle(videoId) {
    const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return { title: videoId, author: '' };
        const data = await res.json();
        return { title: data.title || videoId, author: data.author_name || '' };
    } catch {
        return { title: videoId, author: '' };
    }
}

// ── Push ────────────────────────────────────────────────────────────────────

/**
 * ntfy push. The phone already has io.heckel.ntfy installed and subscribed to
 * the default topic, so this needs no setup on the device.
 *
 * Click opens ytsum://summary/<id>, a custom scheme the Android app claims
 * outright — no Digital Asset Links, no browser disambiguation dialog.
 */
export async function notify(topic, { title, message, videoId }) {
    if (!topic) return { ok: false, reason: 'no-topic' };
    try {
        const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
            method: 'POST',
            headers: {
                'Title': asciiHeader(title),
                'Click': `ytsum://summary/${videoId}`,
                'Tags': 'clapper',
            },
            body: message || '',
            signal: AbortSignal.timeout(10000),
        });
        return { ok: res.ok, status: res.status };
    } catch (e) {
        return { ok: false, reason: e.message };
    }
}

// HTTP header values must be latin-1; video titles are full of em dashes and
// emoji, which throw in undici's header validation and would otherwise take the
// whole notification down.
function asciiHeader(s) {
    return String(s || '')
        .replace(/[^\x20-\x7E]/g, '')
        .slice(0, 200) || 'Summary ready';
}

// ── Read aloud ──────────────────────────────────────────────────────────────
// Sends the summary to the ttsplayer stack, which runs on the same host as this
// bridge — hence localhost rather than the Tailscale name.
//
// Two calls per line, mirroring ~/Dev/scripts/tts-generate.sh:
//   :8882  caching proxy in front of kokoro. NOT :8880, which is raw kokoro with
//          no cache, so replays would re-synthesize every time.
//   :7780  the player itself, so the entry actually shows up in the web UI
//          foldered by project_path.

const TTS_ENDPOINT = process.env.TTS_ENDPOINT || 'http://localhost:8882/v1/audio/speech';
const PLAYER_APPEND = process.env.PLAYER_APPEND || 'http://localhost:7780/api/logs/append?live=0';
const TTS_VOICE = process.env.TTS_VOICE || 'af_sky';
const TTS_MODEL = process.env.TTS_MODEL || 'kokoro';

/**
 * Markdown → lines a voice can actually read.
 *
 * Bullets, hashes and asterisks get spoken literally otherwise ("star star key
 * points star star"), so they are stripped rather than passed through. Long
 * paragraphs are split on sentence boundaries because the player treats one
 * POSTed line as one cache entry and one UI row.
 */
export function toSpeechLines(markdown) {
    const cleaned = String(markdown || '')
        .replace(/```[\s\S]*?```/g, ' ')       // code fences read as noise
        .replace(/`([^`]*)`/g, '$1')
        .replace(/^\s{0,3}#{1,6}\s*/gm, '')    // headings
        .replace(/^\s*[-*+]\s+/gm, '')         // bullet markers
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/\[(.+?)\]\(.+?\)/g, '$1');   // links → their text

    const lines = [];
    for (const block of cleaned.split('\n')) {
        const text = block.trim();
        if (!text) continue;
        // Split into sentences, keeping the terminator.
        const sentences = text.match(/[^.!?]+[.!?]*/g) || [text];
        let buffer = '';
        for (const sentence of sentences) {
            const piece = sentence.trim();
            if (!piece) continue;
            // Merge very short fragments ("Verdict:") into the next sentence so
            // the player does not end up with one-word rows.
            if (buffer) { buffer += ' ' + piece; } else { buffer = piece; }
            if (buffer.length >= 40) { lines.push(buffer); buffer = ''; }
        }
        if (buffer) lines.push(buffer);
    }
    return lines;
}

async function postJson(url, body, timeoutMs = 120_000) {
    return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
    });
}

/**
 * Synthesize every line and file it with the player. Returns per-line counts
 * rather than throwing on the first failure — a summary that is 90% narrated is
 * still worth listening to, and the caller reports what got through.
 */
export async function readAloud(markdown, { title, project }) {
    const lines = toSpeechLines(markdown);
    if (!lines.length) return { ok: false, error: 'nothing to read', lines: 0 };

    const projectPath = project || '/youtube-summaries';
    let spoken = 0, filed = 0, failed = 0;

    // Serial: the proxy synthesizes on a single GPU/CPU pipeline, and firing a
    // whole summary at it concurrently just queues internally with worse errors.
    for (const line of lines) {
        try {
            const res = await postJson(TTS_ENDPOINT, {
                model: TTS_MODEL, input: line, voice: TTS_VOICE, response_format: 'mp3',
            });
            if (!res.ok) { failed++; continue; }
            // Drain the body so the cache write completes before the next call.
            const buf = await res.arrayBuffer();
            spoken++;

            const entry = {
                type: 'tts',
                timestamp: new Date().toISOString().replace(/\.\d+Z$/, ''),
                text: line,
                metadata: {
                    voice: TTS_VOICE,
                    model: TTS_MODEL,
                    // Same rough bytes→seconds ratio tts-generate.sh uses.
                    playback_time: Number((buf.byteLength / 16000).toFixed(2)),
                    project_path: projectPath,
                    title: title || undefined,
                },
            };
            const appendRes = await postJson(PLAYER_APPEND, entry, 30_000);
            if (appendRes.ok) filed++;
        } catch {
            failed++;
        }
    }

    return { ok: spoken > 0, lines: lines.length, spoken, filed, failed, project: projectPath };
}

// ── Self-check ──────────────────────────────────────────────────────────────
// node scripts/summary-store.mjs   → asserts the parsing/formatting logic.

if (process.argv[1] && process.argv[1].endsWith('summary-store.mjs')) {
    const assert = (await import('node:assert')).strict;

    assert.equal(parseVideoId('https://youtu.be/dQw4w9WgXcQ?si=abc'), 'dQw4w9WgXcQ');
    assert.equal(parseVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s'), 'dQw4w9WgXcQ');
    assert.equal(parseVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(parseVideoId('https://www.youtube.com/live/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(parseVideoId('Some title\nhttps://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(parseVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(parseVideoId('https://example.com/nope'), null);
    assert.equal(parseVideoId(null), null);

    assert.equal(formatDuration(0), '0 sec');
    assert.equal(formatDuration(45), '45 sec');
    assert.equal(formatDuration(60), '1 min');
    assert.equal(formatDuration(3725), '62 min 5 sec');

    assert.equal(durationFromSegments([{ t: 0 }, { t: 61_000 }]), 61);
    assert.equal(durationFromSegments([]), 0);
    assert.equal(segmentsToText([{ text: 'a' }, { text: 'b' }]), 'a b');

    // replaceAll, not replace — a template using {{transcript}} twice must get both.
    assert.equal(
        renderPrompt('{{title}} {{transcript}} {{transcript}}', { title: 'T', transcript: 'X' }),
        'T X X',
    );

    assert.equal(asciiHeader('Why — I 🎬 code'), 'Why  I  code');
    assert.equal(asciiHeader(''), 'Summary ready');

    // Markdown must never reach the voice: "**Key points:**" would be read as
    // "star star key points star star".
    const spoken = toSpeechLines(
        '## Key points\n' +
        '- The **first** point is short.\n' +
        'A longer paragraph here. It has two sentences that each clear the merge threshold easily.\n',
    );
    assert.ok(spoken.every(l => !/[*#`]/.test(l)), `markdown leaked: ${JSON.stringify(spoken)}`);
    assert.ok(spoken.some(l => l.includes('first point')), 'bold text should survive unmarked');
    assert.ok(spoken.every(l => l.trim().length > 0));
    assert.equal(toSpeechLines('').length, 0);
    assert.equal(toSpeechLines('   \n\n  ').length, 0);

    const profiles = getProfiles();
    assert.ok(profiles.length === 6, `expected 6 profiles, got ${profiles.length}`);
    assert.equal(getProfile('briefing').id, 'briefing');
    assert.equal(getProfile('nonexistent').id, 'standard', 'unknown id falls back to first');
    assert.ok(getProfile('standard').prompt.includes('{{transcript}}'));

    console.log('summary-store self-check OK');
}
