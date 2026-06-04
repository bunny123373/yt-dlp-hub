/**
 * YT-DLP Hub — downloader.js
 * Real download frontend: talks to Express backend
 * Uses Server-Sent Events for live progress
 */

'use strict';

// ── Backend URL ────────────────────────────────
// Set window.BACKEND_URL in a <script> before this file to override.
// e.g. <script>window.BACKEND_URL = 'https://yt-dlp-hub.onrender.com';</script>
const API = window.BACKEND_URL || 'http://localhost:3001';

// ── State ─────────────────────────────────────
let currentJobId = null;
let currentSSE   = null;
let opts = {
  type: 'video', quality: 'best', fmt: 'mp4',
  subs: false, thumb: false, meta: true,
  playlist: false, cookies: false, sponsor: false
};

// ── DOM refs ──────────────────────────────────
const $ = id => document.getElementById(id);

const urlInput    = $('url-input');
const urlField    = $('url-field');
const urlDetect   = $('url-detect');
const udPlatform  = $('ud-platform');
const udType      = $('ud-type');
const dlBtn       = $('dl-btn');
const dlBtnText   = dlBtn.querySelector('.dl-btn-text');
const dlBtnIcon   = dlBtn.querySelector('.dl-btn-icon');

const progressPanel = $('progress-panel');
const donePanel     = $('done-panel');
const errorPanel    = $('error-panel');
const optsPanel     = $('opts-panel');

// ── Server health check ───────────────────────
async function checkServer() {
  const dot   = $('si-dot');
  const label = $('si-label');
  try {
    const r = await fetch(`${API}/api/status/test`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
    // Any response (even 404) means server is up
    dot.className = 'si-dot online';
    label.textContent = 'Server Online';
    return true;
  } catch (_) {
    dot.className = 'si-dot offline';
    label.textContent = 'Server Offline — run server.js';
    return false;
  }
}
checkServer();
setInterval(checkServer, 10000);

// ── URL detection ─────────────────────────────
const PLATFORMS = [
  { re: /youtube\.com|youtu\.be/,  name: '▶ YouTube' },
  { re: /tiktok\.com/,             name: '🎵 TikTok' },
  { re: /twitch\.tv/,              name: '🎮 Twitch' },
  { re: /instagram\.com/,          name: '📸 Instagram' },
  { re: /soundcloud\.com/,         name: '☁ SoundCloud' },
  { re: /vimeo\.com/,              name: '🎬 Vimeo' },
  { re: /facebook\.com|fb\.watch/, name: '📘 Facebook' },
  { re: /twitter\.com|x\.com/,     name: '🐦 Twitter/X' },
  { re: /bandcamp\.com/,           name: '🎧 Bandcamp' },
  { re: /dailymotion\.com/,        name: '📺 Dailymotion' },
  { re: /reddit\.com/,             name: '🌐 Reddit' },
  { re: /bilibili\.com/,           name: '🎥 Bilibili' },
  { re: /rumble\.com/,             name: '📺 Rumble' },
];

function detectPlatform(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    for (const p of PLATFORMS) {
      if (p.re.test(u.hostname)) return p.name;
    }
    return '🌐 ' + u.hostname;
  } catch (_) {
    return null;
  }
}

urlInput.addEventListener('input', () => {
  const val = urlInput.value.trim();
  dlBtn.disabled = !val.startsWith('http');
  const platform = detectPlatform(val);
  if (platform) {
    udPlatform.textContent = platform;
    udType.textContent     = val.includes('playlist') || val.includes('list=') ? '• Playlist detected' : '• Single video';
    urlDetect.style.display = 'flex';
  } else {
    urlDetect.style.display = 'none';
  }
});

$('url-paste-btn').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    urlInput.value = text;
    urlInput.dispatchEvent(new Event('input'));
  } catch (_) {
    urlInput.focus();
  }
});

$('url-clear-btn').addEventListener('click', () => {
  urlInput.value = '';
  urlInput.dispatchEvent(new Event('input'));
  urlDetect.style.display = 'none';
});

// ── Pill options ──────────────────────────────
document.querySelectorAll('.opill').forEach(pill => {
  pill.addEventListener('click', () => {
    const g = pill.dataset.g;
    document.querySelectorAll(`.opill[data-g="${g}"]`).forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    opts[g] = pill.dataset.v;
    // Auto-select MP3 when audio chosen
    if (g === 'type' && pill.dataset.v === 'audio') {
      document.querySelectorAll('.opill[data-g="fmt"]').forEach(p => p.classList.remove('active'));
      const mp3 = document.querySelector('.opill[data-v="mp3"]');
      if (mp3) { mp3.classList.add('active'); opts.fmt = 'mp3'; }
    }
  });
});

// Toggles
[
  ['chk-subs',     'subs'],
  ['chk-thumb',    'thumb'],
  ['chk-meta',     'meta'],
  ['chk-playlist', 'playlist'],
  ['chk-cookies',  'cookies'],
  ['chk-sponsor',  'sponsor'],
].forEach(([id, key]) => {
  const el = $(id);
  if (el) el.addEventListener('change', () => { opts[key] = el.checked; });
});

// ── Download flow ─────────────────────────────
dlBtn.addEventListener('click', startDownload);

async function startDownload() {
  const url = urlInput.value.trim();
  if (!url) return;

  // Check server first
  const online = await checkServer();
  if (!online) {
    showError('Server not running', 'Please start the backend server first:\n\nnode server.js\n\nThen try again.');
    return;
  }

  // UI: loading state
  dlBtn.disabled = true;
  dlBtn.classList.add('loading');
  dlBtnText.textContent = 'Starting…';

  // Hide other panels
  donePanel.style.display  = 'none';
  errorPanel.style.display = 'none';

  try {
    const res = await fetch(`${API}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, ...opts })
    });

    if (!res.ok) {
      const e = await res.json().catch(() => ({ error: 'Server error' }));
      throw new Error(e.error || `HTTP ${res.status}`);
    }

    const { jobId } = await res.json();
    currentJobId = jobId;

    // Show progress panel
    showProgressPanel();
    subscribeToProgress(jobId);

  } catch (err) {
    showError('Failed to start download', err.message);
    resetBtn();
  }
}

// ── SSE Progress ──────────────────────────────
function subscribeToProgress(jobId) {
  if (currentSSE) { currentSSE.close(); currentSSE = null; }

  const sse = new EventSource(`${API}/api/progress/${jobId}`);
  currentSSE = sse;

  sse.onmessage = e => {
    try {
      const data = JSON.parse(e.data);
      handleEvent(data);
    } catch (_) {}
  };

  sse.onerror = () => {
    sse.close();
    // If job is still running, poll fallback
    if (currentJobId === jobId) {
      setTimeout(() => pollFallback(jobId), 1000);
    }
  };
}

async function pollFallback(jobId) {
  try {
    const res  = await fetch(`${API}/api/status/${jobId}`);
    const data = await res.json();
    if (data.status === 'done') {
      const fileRes = await fetch(`${API}/api/status/${jobId}`);
      // We'll just show a generic done state
      handleEvent({ type: 'done', filename: data.filename, url: `/api/file/${jobId}/${encodeURIComponent(data.filename)}` });
    } else if (data.status === 'error') {
      handleEvent({ type: 'error', message: data.error });
    } else {
      handleEvent({ type: 'progress', progress: data.progress, speed: data.speed, eta: data.eta });
      setTimeout(() => pollFallback(jobId), 800);
    }
  } catch (_) {}
}

function handleEvent(data) {
  switch (data.type) {

    case 'hello':
    case 'status':
      if (data.status === 'downloading') {
        setStatus('⚡', 'Downloading…');
        addLog('Download started', 'info');
      }
      break;

    case 'filename':
      $('pp-filename').textContent = data.filename;
      addLog(`Saving: ${data.filename}`, 'ok');
      break;

    case 'progress':
      updateProgress(data);
      break;

    case 'log':
      addLog(data.message);
      break;

    case 'done':
      if (currentSSE) { currentSSE.close(); currentSSE = null; }
      showDone(data);
      break;

    case 'error':
      if (currentSSE) { currentSSE.close(); currentSSE = null; }
      showError('Download Failed', data.message);
      progressPanel.style.display = 'none';
      break;

    case 'cancelled':
      if (currentSSE) { currentSSE.close(); currentSSE = null; }
      progressPanel.style.display = 'none';
      resetBtn();
      addLog('Download cancelled', 'err');
      break;
  }
}

// ── UI helpers ────────────────────────────────
function showProgressPanel() {
  progressPanel.style.display = 'flex';
  progressPanel.style.flexDirection = 'column';
  $('pp-title').textContent    = 'Starting download…';
  $('pp-filename').textContent = 'Fetching metadata…';
  $('pp-icon').textContent     = '⏳';
  setProgress(0);
  $('sv-speed').textContent = '—';
  $('sv-eta').textContent   = '—';
  $('sv-dl').textContent    = '—';
  $('sv-size').textContent  = '—';
  $('log-body').innerHTML   = '';
  dlBtn.classList.remove('loading');
  dlBtnText.textContent = 'Downloading…';
}

function setStatus(icon, title) {
  $('pp-icon').textContent  = icon;
  $('pp-title').textContent = title;
}

function setProgress(pct) {
  const p = Math.min(100, Math.max(0, pct));
  $('progress-bar-fill').style.width = p + '%';
  $('progress-bar-glow').style.width = p + '%';
  $('progress-pct').textContent      = Math.round(p) + '%';
  if (p >= 100) {
    $('progress-bar-fill').style.background = 'linear-gradient(135deg, #30d158, #00f5ff)';
  }
}

function updateProgress(data) {
  setProgress(data.progress || 0);
  if (data.progress > 0) {
    setStatus('⬇️', `Downloading… ${Math.round(data.progress)}%`);
  }
  if (data.speed)      $('sv-speed').textContent = data.speed;
  if (data.eta)        $('sv-eta').textContent   = data.eta;
  if (data.downloaded) $('sv-dl').textContent    = data.downloaded;
  if (data.total)      $('sv-size').textContent  = data.total;
}

function addLog(msg, cls = '') {
  const body = $('log-body');
  const line = document.createElement('span');
  line.className = 'log-line' + (cls ? ' log-' + cls : '');
  line.textContent = msg;
  body.appendChild(line);
  body.appendChild(document.createElement('br'));
  body.scrollTop = body.scrollHeight;
}

function showDone(data) {
  progressPanel.style.display = 'none';
  setProgress(100);

  const dlUrl  = data.url.startsWith('http') ? data.url : `${API}${data.url}`;
  const fname  = data.filename || 'download';
  const fsize  = data.filesize || '';

  $('done-filename').textContent = fname;
  $('done-filesize').textContent = fsize;
  const btn = $('done-dl-btn');
  btn.href     = dlUrl;
  btn.download = fname;
  btn.setAttribute('target', '_blank');

  donePanel.style.display = 'block';
  resetBtn();
}

function showError(title, msg) {
  $('err-title').textContent = title;
  $('err-msg').textContent   = msg;
  errorPanel.style.display   = 'flex';
  progressPanel.style.display = 'none';
  resetBtn();
}

function resetBtn() {
  dlBtn.disabled = !urlInput.value.trim().startsWith('http');
  dlBtn.classList.remove('loading');
  dlBtnText.textContent = 'Start Download';
}

// Cancel
$('pp-cancel').addEventListener('click', async () => {
  if (!currentJobId) return;
  try {
    await fetch(`${API}/api/cancel/${currentJobId}`, { method: 'POST' });
  } catch (_) {}
  if (currentSSE) { currentSSE.close(); currentSSE = null; }
  progressPanel.style.display = 'none';
  currentJobId = null;
  resetBtn();
});

// Download another
$('done-new-btn').addEventListener('click', () => {
  donePanel.style.display = 'none';
  urlInput.value = '';
  urlInput.dispatchEvent(new Event('input'));
  currentJobId = null;
  resetBtn();
});

// Error retry
$('err-retry-btn').addEventListener('click', () => {
  errorPanel.style.display = 'none';
  resetBtn();
});

// Log toggle
let logVisible = true;
$('log-toggle').addEventListener('click', () => {
  logVisible = !logVisible;
  $('log-body').style.display = logVisible ? 'block' : 'none';
  $('log-toggle').textContent = logVisible ? 'Hide ▲' : 'Show ▼';
});
