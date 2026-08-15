#!/usr/bin/env node
// Local bridge: extension POSTs prompt → spawns `claude -p` → returns stdout.
// Run: node scripts/claude-bridge.mjs              (defaults to PORT=7777)
//      PORT=7779 node scripts/claude-bridge.mjs    (mac, to avoid VoiceMode on 7777)
// Ctrl-C to stop.

import http from 'node:http';
import { spawn } from 'node:child_process';
import {
    parseVideoId, getProfiles, getProfile, renderPrompt, formatDuration,
    segmentsToText, durationFromSegments, readRecord, writeRecord, listRecords,
    fetchTitle, notify, readAloud,
} from './summary-store.mjs';

const PORT = Number(process.env.PORT) || 7777;
// Bind address. Stays loopback-only by default so the desktop extension setup is
// unchanged; the always-on Windows host sets BRIDGE_BIND=0.0.0.0 so the phone can
// reach /api/* over Tailscale.
const BRIDGE_BIND = process.env.BRIDGE_BIND || '127.0.0.1';
// Shared secret for non-loopback /api/* callers. /run executes arbitrary prompts,
// so once the socket is off localhost this is a genuine trust boundary, not
// decoration. Empty token + non-loopback bind = refuse to serve /api at all.
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || '';
const NTFY_TOPIC = process.env.NTFY_TOPIC || 'msokol-general';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const DEFAULT_MODEL = process.env.CLAUDE_MODEL || 'haiku';
// Path to a Python interpreter with `youtube-transcript-api` installed.
// Default points to project-local venv at scripts/.venv.
// Setup: python3 -m venv scripts/.venv && scripts/.venv/bin/pip install youtube-transcript-api
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// HOME is not a real Windows environment variable — pwsh sets it as a shell
// convenience, so it looks present interactively but is absent under Task
// Scheduler. Falling back to '' made this a *relative* '.claude' path, so the
// spawned CLI looked for credentials in the repo, found none, and exited 1.
const HOME_DIR = process.env.HOME || process.env.USERPROFILE || '';
const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME_DIR, '.claude');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENV_PY = process.platform === 'win32'
    ? path.join(__dirname, '.venv', 'Scripts', 'python.exe')
    : path.join(__dirname, '.venv', 'bin', 'python');
const YTT_PYTHON = process.env.YTT_PYTHON || VENV_PY;
// Transcript proxy mode (see runYtt). Set WEBSHARE_PROXY_USERNAME/PASSWORD for
// Webshare residential, or YTT_HTTP_PROXY/YTT_HTTPS_PROXY for a generic proxy.
const PROXY_MODE = (process.env.WEBSHARE_PROXY_USERNAME && process.env.WEBSHARE_PROXY_PASSWORD)
    ? 'webshare'
    : (process.env.YTT_HTTP_PROXY || process.env.YTT_HTTPS_PROXY) ? 'generic' : 'none';
// Hard cap to avoid runaway invocations
const MAX_INPUT_CHARS = 200_000;
// The /api job path gets a bigger cap: a 3-hour video — exactly the case this
// feature exists for — clears 200k chars, and 413-ing it would be worse than
// summarizing a truncated transcript with an explicit marker.
const JOB_MAX_INPUT_CHARS = Number(process.env.JOB_MAX_INPUT_CHARS) || 400_000;
// Kill a wedged `claude` rather than holding the job (and its HTTP request) open
// forever.
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS) || 5 * 60 * 1000;

// Bound to 127.0.0.1 below — only local processes can reach this. Origin allowlist
// keeps stray local pages from probing the bridge while still letting the extension
// (popup + YouTube content script) through.
const ALLOWED_ORIGINS = new Set([
    'https://www.youtube.com',
    'https://m.youtube.com',
]);
const ALLOWED_ORIGIN_PREFIXES = ['chrome-extension://', 'moz-extension://'];

function isOriginAllowed(origin) {
    if (!origin) return true; // same-origin / curl-style requests
    if (ALLOWED_ORIGINS.has(origin)) return true;
    return ALLOWED_ORIGIN_PREFIXES.some(p => origin.startsWith(p));
}

function corsHeaders(origin) {
    return {
        'Access-Control-Allow-Origin': origin || '*',
        'Vary': 'Origin',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
    };
}

async function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => {
            data += chunk;
            if (data.length > MAX_INPUT_CHARS + 4096) {
                reject(new Error('payload too large'));
                req.destroy();
            }
        });
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });
}

function runYtt(videoId) {
    return new Promise((resolve) => {
        const script = `
import sys, json, os
from youtube_transcript_api import YouTubeTranscriptApi
try:
    # Optional proxy to dodge YouTube IP bans. Webshare residential proxies are
    # supported natively (rotating); a generic HTTP/HTTPS proxy also works.
    #   Webshare:  WEBSHARE_PROXY_USERNAME / WEBSHARE_PROXY_PASSWORD
    #   Generic:   YTT_HTTP_PROXY / YTT_HTTPS_PROXY  (e.g. http://user:pass@host:port)
    proxy_config = None
    wu = os.environ.get('WEBSHARE_PROXY_USERNAME')
    wp = os.environ.get('WEBSHARE_PROXY_PASSWORD')
    hp = os.environ.get('YTT_HTTP_PROXY')
    sp = os.environ.get('YTT_HTTPS_PROXY')
    if wu and wp:
        from youtube_transcript_api.proxies import WebshareProxyConfig
        proxy_config = WebshareProxyConfig(proxy_username=wu, proxy_password=wp)
    elif hp or sp:
        from youtube_transcript_api.proxies import GenericProxyConfig
        proxy_config = GenericProxyConfig(http_url=(hp or sp), https_url=(sp or hp))
    api = YouTubeTranscriptApi(proxy_config=proxy_config) if proxy_config else YouTubeTranscriptApi()
    fetched = api.fetch(sys.argv[1])
    out = {
        'ok': True,
        'language': fetched.language_code,
        'isAsr': fetched.is_generated,
        'videoId': sys.argv[1],
        'segments': [{'t': int(s.start * 1000), 'text': s.text} for s in fetched.snippets],
    }
    sys.stdout.write(json.dumps(out))
except Exception as e:
    sys.stdout.write(json.dumps({'ok': False, 'reason': type(e).__name__, 'message': str(e)}))
`;
        const proc = spawn(YTT_PYTHON, ['-c', script, videoId], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '', spawnErr = null;
        proc.on('error', e => {
            spawnErr = e;
            const msg = e.code === 'ENOENT'
                ? `Python not found at "${YTT_PYTHON}". Setup: python3 -m venv scripts/.venv && scripts/.venv/bin/pip install youtube-transcript-api`
                : `spawn failed: ${e.message}`;
            resolve({ ok: false, reason: 'python-spawn', message: msg });
        });
        proc.stdout.on('data', d => out += d);
        proc.stderr.on('data', d => err += d);
        proc.on('close', code => {
            if (spawnErr) return;
            if (code !== 0) return resolve({ ok: false, reason: 'python-exit', exit: code, stderr: err.slice(0, 500) });
            try { resolve(JSON.parse(out)); }
            catch (e) { resolve({ ok: false, reason: 'python-parse', message: e.message, stdout: out.slice(0, 200) }); }
        });
    });
}

// ── Transcript fetch throttle ────────────────────────────────────────────────
// Opening many videos at once fires many transcript fetches; YouTube then
// rate-blocks the IP (IpBlocked / RequestBlocked). Serialize fetches one at a
// time, wait a randomized 2–5s gap between them (varied so the cadence isn't
// robotic), dedupe concurrent requests for the same video, and back off for a
// cooldown once a block is detected so we stop hammering YouTube.
const TRANSCRIPT_MIN_GAP_MS = Number(process.env.YTT_MIN_GAP_MS) || 2000;
const TRANSCRIPT_MAX_GAP_MS = Number(process.env.YTT_MAX_GAP_MS) || 5000;
const TRANSCRIPT_COOLDOWN_MS = Number(process.env.YTT_COOLDOWN_MS) || 5 * 60 * 1000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Random delay in [min, max], clamped so a min>max env combo can't go negative.
function nextGapMs() {
    const span = Math.max(0, TRANSCRIPT_MAX_GAP_MS - TRANSCRIPT_MIN_GAP_MS);
    return TRANSCRIPT_MIN_GAP_MS + Math.floor(Math.random() * (span + 1));
}

let ytQueue = Promise.resolve();   // serial chain: one Python process at a time
let lastYttAt = 0;                  // timestamp of the last fetch (for min-gap)
let blockedUntil = 0;              // epoch ms: skip fetching until this passes
const ytInFlight = new Map();      // videoId → Promise (dedupe concurrent reqs)

function isBlockResult(r) {
    if (!r || r.ok) return false;
    const s = `${r.reason || ''} ${r.message || ''}`.toLowerCase();
    return s.includes('ipblocked') || s.includes('requestblocked')
        || s.includes('blocking requests') || s.includes('too many requests');
}

// Run task on the serial queue (next item waits for the current one).
function enqueue(task) {
    const run = ytQueue.then(task, task);
    ytQueue = run.then(() => {}, () => {});
    return run;
}

function fetchTranscriptThrottled(videoId) {
    const existing = ytInFlight.get(videoId);
    if (existing) return existing;   // same video already queued/running

    const p = enqueue(async () => {
        // In cooldown → don't even spawn Python; tell the caller to slow down.
        if (Date.now() < blockedUntil) {
            const waitS = Math.ceil((blockedUntil - Date.now()) / 1000);
            return {
                ok: false,
                reason: 'RateLimitCooldown',
                message: `YouTube rate-limited this IP from too many requests. Cooling down ~${waitS}s — open videos more slowly.`,
                cooldownMs: blockedUntil - Date.now(),
            };
        }
        // Wait a randomized gap since the last fetch (skip if enough time passed).
        const gap = nextGapMs();
        const since = Date.now() - lastYttAt;
        if (since < gap) await sleep(gap - since);

        const result = await runYtt(videoId);
        lastYttAt = Date.now();

        if (isBlockResult(result)) {
            blockedUntil = Date.now() + TRANSCRIPT_COOLDOWN_MS;
            console.warn(`[${new Date().toISOString()}] YouTube IP block detected — pausing transcript fetches for ${TRANSCRIPT_COOLDOWN_MS / 1000}s`);
        }
        return result;
    }).finally(() => ytInFlight.delete(videoId));

    ytInFlight.set(videoId, p);
    return p;
}

function runClaude(prompt, model) {
    return new Promise((resolve) => {
        // Headless summarization must not inherit the interactive setup. Without
        // these, the spawned CLI loads the user's MCP servers and UserPromptSubmit
        // hooks and answers with things like "Waiting for you to grant permission
        // for speak()" instead of a summary.
        //   --strict-mcp-config          no MCP servers (none are passed)
        //   --setting-sources project    skip ~/.claude hooks; OAuth still works,
        //                                since credentials come from the keychain
        //                                rather than settings. (--bare would also
        //                                strip hooks but forces ANTHROPIC_API_KEY.)
        const args = [
            '-p', '--model', model || DEFAULT_MODEL,
            '--strict-mcp-config',
            '--setting-sources', 'project',
        ];
        const proc = spawn(CLAUDE_BIN, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, CLAUDE_CONFIG_DIR },
        });
        let out = '', err = '';
        let spawnErr = null;
        let timedOut = false;
        const killTimer = setTimeout(() => {
            timedOut = true;
            proc.kill('SIGKILL');
        }, CLAUDE_TIMEOUT_MS);
        proc.on('error', e => {
            spawnErr = e;
            clearTimeout(killTimer);
            if (e.code === 'ENOENT') {
                err = `claude binary not found at "${CLAUDE_BIN}". Install it or set CLAUDE_BIN env var.`;
            } else {
                err = `spawn failed: ${e.message}`;
            }
            resolve({ code: 127, out: '', err });
        });
        proc.stdout.on('data', d => out += d);
        proc.stderr.on('data', d => err += d);
        proc.on('close', code => {
            clearTimeout(killTimer);
            if (spawnErr) return; // already resolved in 'error' handler
            if (timedOut) {
                return resolve({ code: 124, out, err: `claude timed out after ${CLAUDE_TIMEOUT_MS / 1000}s` });
            }
            resolve({ code, out, err });
        });
        try {
            proc.stdin.write(prompt);
            proc.stdin.end();
        } catch {
            // 'error' handler will resolve
        }
    });
}

// ── Phone summary jobs ───────────────────────────────────────────────────────
// POST /api/summarize returns immediately and the work continues here. The phone
// app is a share-sheet target that must finish() in milliseconds; it learns the
// result from the ntfy push, not from the HTTP response.

const runningJobs = new Set();   // videoIds currently being summarized

function truncateTranscript(text) {
    if (text.length <= JOB_MAX_INPUT_CHARS) return { text, truncated: false };
    return {
        text: text.slice(0, JOB_MAX_INPUT_CHARS) + '\n\n[transcript truncated — video exceeded the length cap]',
        truncated: true,
    };
}

/** Build the prompt for a record, from either a stored profile or free-form text. */
function buildPrompt(rec, { profileId, prompt }) {
    const { text } = truncateTranscript(rec.transcript || '');
    const vars = { title: rec.title, duration: formatDuration(rec.durationSec || 0), transcript: text };
    if (prompt) return renderPrompt(prompt, vars);
    return renderPrompt(getProfile(profileId || rec.profileId || 'standard').prompt, vars);
}

/**
 * Full pipeline: title → transcript → claude → disk → push.
 * Always resolves; failures are written to the record with status 'error' so the
 * phone can show why instead of the entry just never appearing.
 */
async function runSummaryJob(videoId, { profileId, model, url }) {
    runningJobs.add(videoId);
    const started = Date.now();
    let rec = readRecord(videoId) || {};
    rec = {
        ...rec,
        videoId,
        url: url || `https://www.youtube.com/watch?v=${videoId}`,
        profileId: profileId || 'standard',
        model: model || DEFAULT_MODEL,
        status: 'running',
        error: null,
        ts: rec.ts || Date.now(),
        versions: rec.versions || [],
    };
    writeRecord(rec);

    try {
        // Reuse a transcript we already have — a re-share of the same video must
        // not spend another YouTube fetch against the rate limiter.
        if (!rec.transcript) {
            const meta = await fetchTitle(videoId);
            rec.title = meta.title;
            rec.author = meta.author;
            writeRecord(rec);

            const tr = await fetchTranscriptThrottled(videoId);
            if (!tr.ok) throw new Error(`${tr.reason || 'transcript failed'}: ${tr.message || ''}`.trim());
            rec.transcript = segmentsToText(tr.segments);
            rec.durationSec = durationFromSegments(tr.segments);
            rec.language = tr.language || '';
            rec.isAsr = !!tr.isAsr;
            writeRecord(rec);
        }

        const { code, out, err } = await runClaude(buildPrompt(rec, { profileId: rec.profileId }), rec.model);
        if (code !== 0 || !out.trim()) throw new Error(claudeFailure(code, out, err));

        rec.markdown = out.trim();
        rec.status = 'done';
        rec.ts = Date.now();
        rec.elapsedMs = Date.now() - started;
        writeRecord(rec);

        await notify(NTFY_TOPIC, {
            title: rec.title || videoId,
            message: firstLine(rec.markdown),
            videoId,
        });
        console.log(`[${new Date().toISOString()}] job ${videoId} done in ${rec.elapsedMs}ms (${rec.markdown.length}ch)`);
    } catch (e) {
        rec.status = 'error';
        rec.error = e.message;
        rec.ts = Date.now();
        writeRecord(rec);
        // Still push — a silent failure is the worst outcome when the phone is
        // the only place you'd notice.
        await notify(NTFY_TOPIC, {
            title: `Summary failed: ${rec.title || videoId}`,
            message: e.message,
            videoId,
        });
        console.error(`[${new Date().toISOString()}] job ${videoId} failed: ${e.message}`);
    } finally {
        runningJobs.delete(videoId);
    }
}

/**
 * Failure text for a bad `claude` run. It reports auth problems ("Not logged in
 * · Please run /login") on stdout, not stderr, so an stderr-only message loses
 * the one line that says what actually went wrong.
 */
function claudeFailure(code, out, err) {
    const detail = (err || '').trim() || (out || '').trim();
    return detail ? `claude exited ${code}: ${detail.slice(0, 300)}` : `claude exited ${code}`;
}

/** Notification body: the opening sentence, trimmed of markdown noise. */
function firstLine(md) {
    const line = String(md || '').split('\n').map(s => s.trim()).find(Boolean) || '';
    return line.replace(/^#+\s*/, '').replace(/\*\*/g, '').slice(0, 300);
}

/**
 * Every non-loopback caller must present the bearer token — not just /api/*.
 * `/run` spawns `claude -p` with a caller-supplied prompt, so the moment
 * BRIDGE_BIND leaves 127.0.0.1 that route is remote code execution for anyone
 * on the LAN or tailnet. The Origin allowlist is no defence: it deliberately
 * permits requests with no Origin header, which is every curl and every native
 * app. Loopback stays open so the desktop extension needs no changes.
 */
function isAuthorized(req) {
    const remote = req.socket.remoteAddress || '';
    const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (isLoopback) return true;
    if (!BRIDGE_TOKEN) return false;
    return req.headers.authorization === `Bearer ${BRIDGE_TOKEN}`;
}

async function handleApi(req, res, headers, pathname) {
    const json = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && pathname === '/api/profiles') {
        return json(200, { ok: true, profiles: getProfiles().map(({ id, name }) => ({ id, name })) });
    }

    if (req.method === 'GET' && pathname === '/api/summaries') {
        return json(200, { ok: true, summaries: listRecords() });
    }

    const detail = pathname.match(/^\/api\/summaries\/([A-Za-z0-9_-]{11})$/);
    if (req.method === 'GET' && detail) {
        const rec = readRecord(detail[1]);
        if (!rec) return json(404, { ok: false, error: 'not found' });
        // Transcript can be hundreds of KB and the phone never renders it.
        const { transcript, ...rest } = rec;
        return json(200, { ok: true, summary: { ...rest, transcriptChars: (transcript || '').length } });
    }

    const regen = pathname.match(/^\/api\/summaries\/([A-Za-z0-9_-]{11})\/regenerate$/);
    if (req.method === 'POST' && regen) {
        const videoId = regen[1];
        const rec = readRecord(videoId);
        if (!rec) return json(404, { ok: false, error: 'not found' });
        if (runningJobs.has(videoId)) return json(409, { ok: false, error: 'already running' });
        if (!rec.transcript) return json(409, { ok: false, error: 'no cached transcript — re-share the video' });

        const { profileId, prompt, model } = JSON.parse((await readBody(req)) || '{}');
        if (prompt && typeof prompt !== 'string') return json(400, { ok: false, error: 'prompt must be a string' });

        // Keep the old summary so a worse regeneration isn't a one-way door.
        if (rec.markdown) {
            rec.versions = [
                ...(rec.versions || []),
                { markdown: rec.markdown, profileId: rec.profileId, model: rec.model, ts: rec.ts, customPrompt: rec.customPrompt || null },
            ].slice(-10);
        }
        rec.status = 'running';
        rec.error = null;
        rec.profileId = profileId || rec.profileId;
        rec.customPrompt = prompt || null;
        rec.model = model || rec.model || DEFAULT_MODEL;
        writeRecord(rec);
        json(202, { ok: true, videoId });

        runningJobs.add(videoId);
        (async () => {
            const t0 = Date.now();
            try {
                const { code, out, err } = await runClaude(buildPrompt(rec, { profileId: rec.profileId, prompt }), rec.model);
                if (code !== 0 || !out.trim()) throw new Error(claudeFailure(code, out, err));
                rec.markdown = out.trim();
                rec.status = 'done';
                rec.ts = Date.now();
                rec.elapsedMs = Date.now() - t0;
            } catch (e) {
                rec.status = 'error';
                rec.error = e.message;
            }
            writeRecord(rec);
            console.log(`[${new Date().toISOString()}] regenerate ${videoId} → ${rec.status}`);
            runningJobs.delete(videoId);
        })();
        return;
    }

    // Hand the summary to the player. One append that returns in well under a
    // second, so there is no job to track and nothing to poll or push about —
    // the phone just shows a toast.
    const audio = pathname.match(/^\/api\/summaries\/([A-Za-z0-9_-]{11})\/audio$/);
    if (req.method === 'POST' && audio) {
        const videoId = audio[1];
        const rec = readRecord(videoId);
        if (!rec) return json(404, { ok: false, error: 'not found' });
        if (!rec.markdown) return json(409, { ok: false, error: 'no summary to read yet' });

        const result = await readAloud(rec.markdown, {
            videoId,
            project: process.env.TTS_PROJECT || '/youtube-summaries',
        });
        console.log(`[${new Date().toISOString()}] audio ${videoId} → ${result.ok ? `sent ${result.chars}ch` : result.error}`);
        return json(result.ok ? 200 : 502, result);
    }

    if (req.method === 'POST' && pathname === '/api/summarize') {
        const { url, profileId, model, force } = JSON.parse((await readBody(req)) || '{}');
        const videoId = parseVideoId(url);
        if (!videoId) return json(400, { ok: false, error: 'could not parse a YouTube video ID' });
        if (runningJobs.has(videoId)) return json(202, { ok: true, videoId, status: 'running' });

        const existing = readRecord(videoId);
        if (existing?.status === 'done' && !force) {
            return json(200, { ok: true, videoId, status: 'done', cached: true });
        }

        json(202, { ok: true, videoId, status: 'running' });
        runSummaryJob(videoId, { profileId, model, url });   // deliberately not awaited
        return;
    }

    return json(404, { ok: false, error: 'not found' });
}

const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin || '';
    if (!isOriginAllowed(origin)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: `origin not allowed: ${origin}` }));
    }
    const headers = corsHeaders(origin);

    if (req.method === 'OPTIONS') {
        res.writeHead(204, headers);
        return res.end();
    }

    if (!isAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json', ...headers });
        return res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    }

    // Phone/share API. Split off before the extension routes so its own auth and
    // error shape stay self-contained.
    const pathname = (req.url || '').split('?')[0];
    if (pathname.startsWith('/api/')) {
        try {
            return await handleApi(req, res, headers, pathname);
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json', ...headers });
            return res.end(JSON.stringify({ ok: false, error: e.message }));
        }
    }
    // Lightweight health probe for popup status row.
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
        return res.end(JSON.stringify({
            ok: true,
            port: PORT,
            defaultModel: DEFAULT_MODEL,
            pythonPath: YTT_PYTHON,
            proxy: PROXY_MODE,
        }));
    }
    if (req.method === 'POST' && req.url === '/transcript') {
        try {
            const body = await readBody(req);
            const { videoId } = JSON.parse(body || '{}');
            if (typeof videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
                res.writeHead(400, { 'Content-Type': 'application/json', ...headers });
                return res.end(JSON.stringify({ ok: false, error: 'invalid videoId' }));
            }
            const t0 = Date.now();
            const result = await fetchTranscriptThrottled(videoId);
            const ms = Date.now() - t0;
            console.log(`[${new Date().toISOString()}] /transcript ${videoId} → ${result.ok ? result.segments.length + ' segs' : result.reason} in ${ms}ms`);
            res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
            return res.end(JSON.stringify({ ...result, elapsedMs: ms }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json', ...headers });
            return res.end(JSON.stringify({ ok: false, error: e.message }));
        }
    }

    if (req.method !== 'POST' || req.url !== '/run') {
        res.writeHead(404, headers);
        return res.end('not found');
    }

    try {
        const body = await readBody(req);
        const { prompt, model } = JSON.parse(body || '{}');
        if (typeof prompt !== 'string' || prompt.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json', ...headers });
            return res.end(JSON.stringify({ ok: false, error: 'missing prompt' }));
        }
        if (prompt.length > MAX_INPUT_CHARS) {
            res.writeHead(413, { 'Content-Type': 'application/json', ...headers });
            return res.end(JSON.stringify({ ok: false, error: 'prompt too long' }));
        }

        const t0 = Date.now();
        const { code, out, err } = await runClaude(prompt, model);
        const ms = Date.now() - t0;
        console.log(`[${new Date().toISOString()}] ${prompt.length}ch → ${out.length}ch in ${ms}ms (exit ${code})`);

        res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify({
            ok: code === 0,
            output: out.trim(),
            error: code !== 0 ? err.trim() : null,
            elapsedMs: ms,
        }));
    } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify({ ok: false, error: e.message }));
    }
});

server.listen(PORT, BRIDGE_BIND, () => {
    console.log(`claude-bridge ready on http://${BRIDGE_BIND}:${PORT}`);
    console.log(`POST /run         body: { "prompt": "...", "model": "haiku|sonnet|opus" }`);
    console.log(`POST /transcript  body: { "videoId": "..." }  python: ${YTT_PYTHON}`);
    console.log(`POST /api/summarize  body: { "url": "..." }   ntfy topic: ${NTFY_TOPIC}`);
    if (BRIDGE_BIND !== '127.0.0.1' && !BRIDGE_TOKEN) {
        console.warn('  WARNING: bound off-loopback with no BRIDGE_TOKEN — /api/* will reject every remote request.');
    }
    console.log(`transcript proxy: ${PROXY_MODE}  ·  throttle: serial, ${TRANSCRIPT_MIN_GAP_MS}-${TRANSCRIPT_MAX_GAP_MS}ms gap, ${TRANSCRIPT_COOLDOWN_MS / 1000}s cooldown on block`);
    if (PROXY_MODE === 'none') {
        console.log('  (no proxy — set WEBSHARE_PROXY_USERNAME/PASSWORD to avoid IP bans when bursting)');
    }
});
