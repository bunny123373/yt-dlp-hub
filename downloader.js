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
let currentJobId  = null;
let currentSSE    = null;
let currentInfo   = null;   // fetched video metadata
let infoCtr       = 0;      // cancel stale requests
let infoDebounce  = null;
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
  // Debounce info fetch
  clearTimeout(infoDebounce);
  if (val.startsWith('http')) {
    infoDebounce = setTimeout(() => fetchVideoInfo(val), 600);
  } else {
    hidePreview();
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
  hidePreview();
  currentInfo = null;
});

// ── Video Info Fetch ──────────────────────────
function fmtDuration(secs) {
  if (!secs) return '';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function fmtViews(n) {
  if (!n) return '';
  if (n >= 1e9) return (n/1e9).toFixed(1) + 'B views';
  if (n >= 1e6) return (n/1e6).toFixed(1) + 'M views';
  if (n >= 1e3) return (n/1e3).toFixed(0) + 'K views';
  return n + ' views';
}

function fmtDate(d) {
  if (!d || d.length < 8) return '';
  return d.slice(0,4) + '-' + d.slice(4,6) + '-' + d.slice(6,8);
}

async function fetchVideoInfo(url) {
  const ctr = ++infoCtr;
  showPreviewLoading();
  try {
    const res  = await fetch(`${API}/api/info?url=${encodeURIComponent(url)}`);
    if (ctr !== infoCtr) return; // stale
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed' }));
      showPreviewError(err.error);
      return;
    }
    const info = await res.json();
    if (ctr !== infoCtr) return;
    currentInfo = info;
    showPreviewCard(info);
  } catch (e) {
    if (ctr !== infoCtr) return;
    showPreviewError('Network error — is the server awake?');
  }
}

function showPreviewLoading() {
  const vp = $('video-preview');
  vp.style.display   = 'block';
  $('vp-loading').style.display = 'flex';
  $('vp-card').style.display    = 'none';
  $('vp-error').style.display   = 'none';
}

function showPreviewCard(info) {
  const vp = $('video-preview');
  vp.style.display   = 'block';
  $('vp-loading').style.display = 'none';
  $('vp-error').style.display   = 'none';
  $('vp-card').style.display    = 'flex';

  $('vp-thumb').src        = info.thumbnail || '';
  $('vp-thumb').style.display = info.thumbnail ? 'block' : 'none';
  $('vp-dur').textContent  = fmtDuration(info.duration);
  $('vp-platform').textContent = info.extractor || detectPlatform(urlInput.value.trim()) || 'Web';
  $('vp-title-card').textContent  = info.title;
  $('vp-channel').textContent     = info.uploader ? '@ ' + info.uploader : '';
  $('vp-views').textContent       = fmtViews(info.view_count);
  $('vp-date').textContent        = fmtDate(info.upload_date);
}

function showPreviewError(msg) {
  const vp = $('video-preview');
  vp.style.display   = 'block';
  $('vp-loading').style.display = 'none';
  $('vp-card').style.display    = 'none';
  $('vp-error').style.display   = 'flex';
  $('vp-error-msg').textContent = msg || 'Could not fetch video info';
}

function hidePreview() {
  $('video-preview').style.display = 'none';
  $('vp-card').style.display = 'none';
}

$('vp-clear').addEventListener('click', () => {
  hidePreview();
  currentInfo = null;
  urlInput.value = '';
  urlInput.dispatchEvent(new Event('input'));
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
        const zapSvg = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>';
        setStatus(zapSvg, currentInfo ? currentInfo.title : 'Downloading…');
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
  const title = currentInfo ? currentInfo.title : 'Downloading…';
  $('pp-title').textContent    = title;
  $('pp-filename').textContent = 'Starting up…';
  // Clock SVG icon
  $('pp-icon').innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
  // Show video thumbnail strip if we have info
  if (currentInfo && currentInfo.thumbnail) {
    $('ppv-thumb').src = currentInfo.thumbnail;
    $('ppv-title').textContent   = currentInfo.title || '';
    $('ppv-channel').textContent = currentInfo.uploader ? '@ ' + currentInfo.uploader : '';
    $('pp-video-info').style.display = 'flex';
  } else {
    $('pp-video-info').style.display = 'none';
  }
  setProgress(0);
  $('sv-speed').textContent = '—';
  $('sv-eta').textContent   = '—';
  $('sv-dl').textContent    = '—';
  $('sv-size').textContent  = '—';
  $('log-body').innerHTML   = '';
  dlBtn.classList.remove('loading');
  dlBtnText.textContent = 'Downloading…';
  hidePreview();
}

function setStatus(iconSvg, title) {
  $('pp-icon').innerHTML  = iconSvg;
  // Only update title if not already showing real video title
  if (!currentInfo || !currentInfo.title) {
    $('pp-title').textContent = title;
  }
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
    const dlSvg = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
    setStatus(dlSvg, currentInfo ? currentInfo.title : `Downloading… ${Math.round(data.progress)}%`);
    if (!currentInfo) $('pp-filename').textContent = `${Math.round(data.progress)}% complete`;
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

// ── Cookie Auth Panel ─────────────────────────
(async function initCookiePanel() {
  const dot        = $('cp-dot');
  const statusText = $('cp-status-text');
  const body       = $('cp-body');
  const toggle     = $('cp-toggle');
  const header     = $('cp-header');
  const feedback   = $('cp-feedback');
  const fileInput  = $('cp-file-input');
  const uploadArea = $('cp-upload-area');
  let open = false;

  async function checkCookies() {
    try {
      const r = await fetch(`${API}/api/cookies/status`);
      const d = await r.json();
      if (d.hasCookies) {
        dot.className = 'cp-dot has-cookies';
        statusText.textContent = '✓ Cookies active';
      } else {
        dot.className = 'cp-dot no-cookies';
        statusText.textContent = 'No cookies';
      }
    } catch (_) {
      dot.className = 'cp-dot';
      statusText.textContent = 'Server offline';
    }
  }
  checkCookies();

  toggle.addEventListener('click', () => {
    open = !open;
    body.style.display = open ? 'flex' : 'none';
    header.classList.toggle('open', open);
    toggle.querySelector('svg').style.transform = open ? 'rotate(180deg)' : '';
  });

  function showFeedback(msg, type) {
    feedback.textContent = msg;
    feedback.className = 'cp-feedback ' + type;
    feedback.style.display = 'block';
    setTimeout(() => { feedback.style.display = 'none'; }, 4000);
  }

  async function uploadCookies(text) {
    try {
      const r = await fetch(`${API}/api/cookies`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: text
      });
      const d = await r.json();
      if (r.ok) {
        showFeedback('✓ ' + d.message, 'ok');
        checkCookies();
      } else {
        showFeedback('✗ ' + d.error, 'err');
      }
    } catch (e) {
      showFeedback('✗ Upload failed: ' + e.message, 'err');
    }
  }

  // File browse
  $('cp-browse-btn').addEventListener('click', e => { e.stopPropagation(); fileInput.click(); });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => uploadCookies(e.target.result);
    reader.readAsText(file);
  });

  // Drag & drop
  uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.classList.add('drag-over'); });
  uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('drag-over'));
  uploadArea.addEventListener('drop', e => {
    e.preventDefault(); uploadArea.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => uploadCookies(ev.target.result);
    reader.readAsText(file);
  });
  uploadArea.addEventListener('click', () => fileInput.click());

  // Clear
  $('cp-clear-btn').addEventListener('click', async e => {
    e.stopPropagation();
    try {
      await fetch(`${API}/api/cookies`, { method: 'DELETE' });
      showFeedback('Cookies cleared', 'ok');
      checkCookies();
    } catch (_) { showFeedback('Failed to clear', 'err'); }
  });
})();
