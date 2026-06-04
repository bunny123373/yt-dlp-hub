/**
 * YT-DLP Hub — Backend Server
 * Real download engine using yt-dlp
 * Express + Server-Sent Events for live progress
 */

'use strict';

const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');
const { spawn }  = require('child_process');
const { v4: uuid } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── yt-dlp command (fallback to python3 -m yt_dlp on cloud) ─
const YTDLP_CMD  = process.env.YTDLP_CMD || 'yt-dlp';
const YTDLP_ARGS = YTDLP_CMD.includes('python') ? ['-m', 'yt_dlp'] : [];

// ── Directories ─────────────────────────────
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const PUBLIC_DIR    = path.join(__dirname, '.');
const COOKIES_FILE  = path.join(__dirname, 'yt-cookies.txt');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

// ── Restore cookies from env var (survives restarts) ─
if (process.env.YT_COOKIES_B64 && !fs.existsSync(COOKIES_FILE)) {
  try {
    const decoded = Buffer.from(process.env.YT_COOKIES_B64, 'base64').toString('utf8');
    fs.writeFileSync(COOKIES_FILE, decoded, 'utf8');
    console.log('  ✓ YouTube cookies restored from environment variable');
  } catch (e) {
    console.error('  ✗ Failed to restore cookies from env:', e.message);
  }
}

// ── In-memory job store ─────────────────────
// { [jobId]: { status, progress, speed, eta, filename, filepath, error, clients:Set } }
const jobs = new Map();

// ── Middleware ───────────────────────────────
app.use(cors({ origin: '*', methods: ['GET','POST'], credentials: false }));
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// ── Helpers ──────────────────────────────────
function broadcastToJob(jobId, data) {
  const job = jobs.get(jobId);
  if (!job) return;
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  job.clients.forEach(res => {
    try { res.write(msg); } catch (_) {}
  });
}

function cleanupJob(jobId, delayMs = 60000) {
  setTimeout(() => {
    const job = jobs.get(jobId);
    if (!job) return;
    // Close all SSE connections
    job.clients.forEach(res => { try { res.end(); } catch (_) {} });
    // Delete the file
    if (job.filepath && fs.existsSync(job.filepath)) {
      try { fs.unlinkSync(job.filepath); } catch (_) {}
    }
    jobs.delete(jobId);
  }, delayMs);
}

function buildYtdlpArgs(opts) {
  const { url, type, quality, fmt, subs, thumb, meta, playlist, cookies, sponsor } = opts;
  const args = [];
  const jobId = opts.jobId;
  const outTemplate = path.join(DOWNLOADS_DIR, `${jobId}_%(title).80s.%(ext)s`);

  args.push('-o', outTemplate);

  // Progress machine-readable output
  args.push('--progress-template', '%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress._downloaded_bytes_str)s|%(progress._total_bytes_str)s');
  args.push('--newline');

  // No cache
  args.push('--no-playlist');

  if (type === 'audio') {
    args.push('-x');
    const af = ['mp3', 'flac', 'opus', 'm4a', 'wav'].includes(fmt) ? fmt : 'mp3';
    args.push('--audio-format', af, '--audio-quality', '0');
  } else if (type === 'thumbnail') {
    args.push('--write-thumbnail', '--skip-download', '--convert-thumbnails', 'jpg');
  } else if (type === 'subs') {
    args.push('--write-subs', '--write-auto-subs', '--skip-download', '--sub-format', 'srt/best');
  } else {
    // video — works with both DASH (web) and progressive (iOS/HLS)
    let fmtStr;
    if (quality === 'best') {
      fmtStr = 'bestvideo+bestaudio/best';
    } else {
      fmtStr = [
        `bestvideo[height<=${quality}]+bestaudio`,
        `best[height<=${quality}]`,
        'bestvideo+bestaudio',
        'best'
      ].join('/');
    }
    args.push('-f', fmtStr);
    const mfmt = ['mp4', 'mkv', 'webm'].includes(fmt) ? fmt : 'mp4';
    args.push('--merge-output-format', mfmt);
  }

  if (subs && type === 'video')  { args.push('--embed-subs', '--write-auto-subs'); }
  if (thumb && type !== 'thumbnail') { args.push('--embed-thumbnail'); }
  if (meta)                      { args.push('--add-metadata'); }
  if (playlist)                  { args.push('--yes-playlist'); delete args[args.indexOf('--no-playlist')]; }
  if (cookies)                   { args.push('--cookies-from-browser', 'chrome'); }
  if (sponsor)                   { args.push('--sponsorblock-mark', 'all'); }

  // YouTube: use TV/Android clients — bypass bot detection without cookies
  const isYouTube = /youtube\.com|youtu\.be/.test(url);
  if (isYouTube) {
    // tv_embedded and android clients don't require login/cookies
    args.push('--extractor-args', 'youtube:player_client=tv_embedded,ios,web');
  }

  // Use cookies file if it exists (user-uploaded)
  if (fs.existsSync(COOKIES_FILE)) {
    args.push('--cookies', COOKIES_FILE);
  }

  args.push('--socket-timeout', '30');
  args.push('--retries', '3');
  args.push('--no-warnings');
  args.push(url);

  return args.filter(Boolean);
}

// ── Routes ───────────────────────────────────

// 0. Health check
app.get('/api/health', (req, res) => res.json({ ok: true, version: '1.0' }));

// 1. Start a download job
app.post('/api/download', (req, res) => {
  const { url, type = 'video', quality = 'best', fmt = 'mp4',
          subs = false, thumb = false, meta = true,
          playlist = false, cookies = false, sponsor = false } = req.body;

  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const jobId = uuid();
  jobs.set(jobId, {
    status: 'queued', progress: 0, speed: '—', eta: '—',
    downloaded: '0 B', total: '?', filename: null, filepath: null,
    error: null, clients: new Set()
  });

  res.json({ jobId });

  // Start yt-dlp in background
  setImmediate(() => runDownload(jobId, { url, type, quality, fmt, subs, thumb, meta, playlist, cookies, sponsor }));
});

function runDownload(jobId, opts) {
  const job = jobs.get(jobId);
  if (!job) return;

  job.status = 'downloading';
  broadcastToJob(jobId, { type: 'status', status: 'downloading' });

  const extraArgs = buildYtdlpArgs({ ...opts, jobId });
  const allArgs   = [...YTDLP_ARGS, ...extraArgs];
  console.log(`[${jobId}] ${YTDLP_CMD} ${allArgs.join(' ')}`);

  const proc = spawn(YTDLP_CMD, allArgs, { cwd: DOWNLOADS_DIR });
  job.proc = proc;

  proc.stdout.on('data', chunk => {
    const lines = chunk.toString().split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      // Progress line: "percent|speed|eta|downloaded|total"
      if (line.includes('%')) {
        const parts = line.split('|');
        if (parts.length >= 2) {
          const pctRaw = parts[0].trim().replace('%', '').trim();
          const pct = parseFloat(pctRaw);
          if (!isNaN(pct)) {
            job.progress   = pct;
            job.speed      = (parts[1] || '').trim();
            job.eta        = (parts[2] || '').trim();
            job.downloaded = (parts[3] || '').trim();
            job.total      = (parts[4] || '').trim();
            broadcastToJob(jobId, {
              type: 'progress',
              progress:   pct,
              speed:      job.speed,
              eta:        job.eta,
              downloaded: job.downloaded,
              total:      job.total
            });
          }
        }
      } else if (line.startsWith('[download] Destination:')) {
        const fp = line.replace('[download] Destination:', '').trim();
        job.filepath = fp;
        job.filename = path.basename(fp);
        broadcastToJob(jobId, { type: 'filename', filename: job.filename });
      } else if (line.startsWith('[Merger]') || line.includes('Destination:')) {
        // merged file
        const match = line.match(/Destination:\s*(.+)/);
        if (match) { job.filepath = match[1].trim(); job.filename = path.basename(job.filepath); }
      }
      console.log(`[${jobId}] ${line}`);
    }
  });

  let stderrBuf = '';
  proc.stderr.on('data', chunk => {
    const line = chunk.toString().trim();
    stderrBuf += line + '\n';
    if (line) {
      console.error(`[${jobId}] ERR: ${line}`);
      if (!line.includes('WARNING') && !line.includes('Merging')) {
        broadcastToJob(jobId, { type: 'log', message: line });
      }
    }
  });

  proc.on('error', err => {
    // If yt-dlp not found, retry with python3 -m yt_dlp
    if (err.code === 'ENOENT' && YTDLP_CMD === 'yt-dlp') {
      console.log(`[${jobId}] yt-dlp not found, retrying with python3 -m yt_dlp`);
      broadcastToJob(jobId, { type: 'log', message: 'Retrying with python3...' });
      const extraArgs = buildYtdlpArgs({ ...opts, jobId });
      const proc2 = spawn('python3', ['-m', 'yt_dlp', ...extraArgs], { cwd: DOWNLOADS_DIR });
      job.proc = proc2;
      attachHandlers(proc2, job, jobId, opts);
    } else {
      job.status = 'error';
      job.error  = `Failed to start yt-dlp: ${err.message}. Is yt-dlp installed?`;
      broadcastToJob(jobId, { type: 'error', message: job.error });
      cleanupJob(jobId, 5000);
    }
  });

  proc.on('close', code => {
    if (code === 0) {
      // Find the actual output file (may differ from template)
      let finalFile = job.filepath;
      if (!finalFile || !fs.existsSync(finalFile)) {
        // Search downloads dir for files with jobId
        const files = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.startsWith(jobId));
        if (files.length > 0) {
          // Pick the largest file (likely the video)
          const sorted = files
            .map(f => ({ f, size: fs.statSync(path.join(DOWNLOADS_DIR, f)).size }))
            .sort((a, b) => b.size - a.size);
          finalFile = path.join(DOWNLOADS_DIR, sorted[0].f);
        }
      }

      if (finalFile && fs.existsSync(finalFile)) {
        job.status   = 'done';
        job.filepath = finalFile;
        job.filename = path.basename(finalFile);
        job.progress = 100;
        const stat   = fs.statSync(finalFile);
        broadcastToJob(jobId, {
          type:     'done',
          filename: job.filename,
          filesize: formatBytes(stat.size),
          url:      `/api/file/${jobId}/${encodeURIComponent(job.filename)}`
        });
        cleanupJob(jobId, 10 * 60 * 1000); // Delete file after 10 mins
      } else {
        job.status = 'error';
        job.error  = 'Output file not found after download';
        broadcastToJob(jobId, { type: 'error', message: job.error });
        cleanupJob(jobId, 5000);
      }
    } else {
      job.status = 'error';
      // Extract meaningful error from stderr buffer
      const errLines  = stderrBuf.split('\n').filter(l => l.trim() && !l.includes('WARNING'));
      const lastError = errLines.filter(l => l.toLowerCase().includes('error') || l.includes('ERROR')).pop()
                     || errLines.pop()
                     || `yt-dlp exited with code ${code}`;
      job.error  = lastError.replace(/^ERROR:\s*/i, '');
      // Replace raw YouTube bot error with friendly message
      if (job.error.includes('Sign in to confirm') || job.error.includes('not a bot')) {
        job.error = 'YouTube is restricting this video. Try a different video URL, or use a direct link.';
      }
      broadcastToJob(jobId, { type: 'error', message: job.error });
      cleanupJob(jobId, 5000);
    }
  });
}

function attachHandlers(proc, job, jobId, opts) {
  // Re-attach stdout/stderr handlers for retry proc
  proc.stdout.on('data', chunk => {
    const lines = chunk.toString().split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.includes('%')) {
        const parts = line.split('|');
        if (parts.length >= 2) {
          const pct = parseFloat(parts[0].replace('%', '').trim());
          if (!isNaN(pct)) {
            job.progress = pct; job.speed = (parts[1]||'').trim();
            job.eta = (parts[2]||'').trim(); job.downloaded = (parts[3]||'').trim(); job.total = (parts[4]||'').trim();
            broadcastToJob(jobId, { type:'progress', progress:pct, speed:job.speed, eta:job.eta, downloaded:job.downloaded, total:job.total });
          }
        }
      } else if (line.startsWith('[download] Destination:')) {
        const fp = line.replace('[download] Destination:', '').trim();
        job.filepath = fp; job.filename = path.basename(fp);
        broadcastToJob(jobId, { type: 'filename', filename: job.filename });
      }
    }
  });
  proc.stderr.on('data', chunk => { console.error(`[retry] ${chunk.toString().trim()}`); });
  proc.on('error', err => {
    job.status = 'error'; job.error = err.message;
    broadcastToJob(jobId, { type: 'error', message: err.message }); cleanupJob(jobId, 5000);
  });
  proc.on('close', code => {
    if (code === 0) {
      let finalFile = job.filepath;
      if (!finalFile || !fs.existsSync(finalFile)) {
        const files = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.startsWith(jobId));
        if (files.length > 0) {
          finalFile = path.join(DOWNLOADS_DIR, files.sort((a,b) => fs.statSync(path.join(DOWNLOADS_DIR,b)).size - fs.statSync(path.join(DOWNLOADS_DIR,a)).size)[0]);
        }
      }
      if (finalFile && fs.existsSync(finalFile)) {
        job.status = 'done'; job.filepath = finalFile; job.filename = path.basename(finalFile); job.progress = 100;
        broadcastToJob(jobId, { type:'done', filename:job.filename, filesize:formatBytes(fs.statSync(finalFile).size), url:`/api/file/${jobId}/${encodeURIComponent(job.filename)}` });
        cleanupJob(jobId, 10 * 60 * 1000);
      } else {
        job.status='error'; job.error='Output file not found';
        broadcastToJob(jobId, { type:'error', message:job.error }); cleanupJob(jobId, 5000);
      }
    } else {
      job.status='error'; job.error=`yt-dlp exited with code ${code}`;
      broadcastToJob(jobId, { type:'error', message:job.error }); cleanupJob(jobId, 5000);
    }
  });
}

// 2. Upload YouTube cookies.txt (to bypass bot detection)
app.post('/api/cookies', express.text({ type: '*/*', limit: '2mb' }), (req, res) => {
  const body = req.body;
  if (!body || !body.includes('youtube.com')) {
    return res.status(400).json({ error: 'Invalid cookies file — must be Netscape format containing youtube.com cookies' });
  }
  try {
    fs.writeFileSync(COOKIES_FILE, body, 'utf8');
    res.json({ ok: true, message: 'Cookies saved — YouTube downloads now authenticated' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save cookies: ' + e.message });
  }
});

app.get('/api/cookies/status', (req, res) => {
  const exists = fs.existsSync(COOKIES_FILE);
  res.json({ hasCookies: exists, path: exists ? COOKIES_FILE : null });
});

app.delete('/api/cookies', (req, res) => {
  if (fs.existsSync(COOKIES_FILE)) fs.unlinkSync(COOKIES_FILE);
  res.json({ ok: true });
});

// 3. Fetch video metadata (title, thumbnail, channel, duration)
app.get('/api/info', (req, res) => {
  const { url } = req.query;
  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const baseArgs = ['--dump-json', '--no-playlist', '--no-warnings',
                    '--socket-timeout', '20', url];
  const allArgs  = [...YTDLP_ARGS, ...baseArgs];
  const proc     = spawn(YTDLP_CMD, allArgs);

  let output = '';
  let errOut = '';
  proc.stdout.on('data', c => { output += c.toString(); });
  proc.stderr.on('data', c => { errOut += c.toString(); });

  proc.on('error', err => {
    if (err.code === 'ENOENT') {
      // fallback python3
      const p2 = spawn('python3', ['-m', 'yt_dlp', ...baseArgs]);
      let o2 = '', e2 = '';
      p2.stdout.on('data', c => { o2 += c.toString(); });
      p2.stderr.on('data', c => { e2 += c.toString(); });
      p2.on('close', code => {
        if (code === 0) { sendInfo(res, o2); }
        else { res.status(500).json({ error: e2.split('\n').pop() || 'Failed' }); }
      });
    } else {
      res.status(500).json({ error: err.message });
    }
  });

  proc.on('close', code => {
    if (code === 0) { sendInfo(res, output); }
    else {
      const msg = errOut.split('\n').filter(l => l.trim() && !l.includes('WARNING')).pop() || 'Could not fetch info';
      res.status(500).json({ error: msg.replace(/^ERROR:\s*/i, '') });
    }
  });
});

function sendInfo(res, rawJson) {
  try {
    const d = JSON.parse(rawJson.trim().split('\n')[0]); // first JSON line
    res.json({
      title:       d.title        || 'Unknown Title',
      uploader:    d.uploader     || d.channel || d.creator || '',
      duration:    d.duration     || 0,
      thumbnail:   d.thumbnail    || '',
      view_count:  d.view_count   || 0,
      like_count:  d.like_count   || 0,
      upload_date: d.upload_date  || '',
      extractor:   d.extractor_key || d.ie_key || '',
      webpage_url: d.webpage_url  || '',
      description: (d.description || '').slice(0, 200),
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to parse metadata' });
  }
}

// 3. SSE — subscribe to job progress
app.get('/api/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  if (!job) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Job not found' })}\n\n`);
    return res.end();
  }

  // Send current state immediately
  res.write(`data: ${JSON.stringify({ type: 'hello', status: job.status, progress: job.progress })}\n\n`);

  job.clients.add(res);

  req.on('close', () => {
    job.clients.delete(res);
  });
});

// 3. Download file
app.get('/api/file/:jobId/:filename', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  if (!job || !job.filepath || !fs.existsSync(job.filepath)) {
    return res.status(404).json({ error: 'File not found or expired' });
  }
  res.download(job.filepath, job.filename, err => {
    if (err) console.error('Download error:', err);
  });
});

// 4. Cancel a job
app.post('/api/cancel/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  if (job) {
    if (job.proc) { try { job.proc.kill('SIGTERM'); } catch (_) {} }
    job.status = 'cancelled';
    broadcastToJob(jobId, { type: 'cancelled' });
    cleanupJob(jobId, 2000);
  }
  res.json({ ok: true });
});

// 5. Job status (polling fallback)
app.get('/api/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json({
    status:   job.status,
    progress: job.progress,
    speed:    job.speed,
    eta:      job.eta,
    filename: job.filename,
    error:    job.error
  });
});

// ── Utility ──────────────────────────────────
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 ** 3) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  return (bytes / 1024 ** 3).toFixed(2) + ' GB';
}

// ── Serve index.html for root ────────────────
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// ── Start ────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  ╔════════════════════════════════════╗');
  console.log('  ║   YT-DLP Hub Server Running        ║');
  console.log(`  ║   http://localhost:${PORT}             ║`);
  console.log('  ╚════════════════════════════════════╝');
  console.log('');
  console.log('  Downloads folder:', DOWNLOADS_DIR);
  console.log('  Press Ctrl+C to stop');
  console.log('');
});
