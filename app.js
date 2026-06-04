/* ===========================================
   YT-DLP HUB — app.js
=========================================== */

'use strict';

// ── Helpers ──────────────────────────────────
const $ = id => document.getElementById(id);
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

// ── Loader ───────────────────────────────────
window.addEventListener('load', () => {
  setTimeout(() => $('loader').classList.add('done'), 800);
});

// ── Navbar ────────────────────────────────────
const nav = $('nav');
window.addEventListener('scroll', () => {
  nav.classList.toggle('solid', window.scrollY > 60);
  const bt = $('back-top');
  if (bt) bt.classList.toggle('show', window.scrollY > 400);
}, { passive: true });

// Hamburger
const ham     = $('hamburger');
const navMenu = $('nav-menu');
if (ham && navMenu) {
  ham.addEventListener('click', () => navMenu.classList.toggle('open'));
  navMenu.querySelectorAll('a').forEach(a => a.addEventListener('click', () => navMenu.classList.remove('open')));
}

// Back to top
const bt = $('back-top');
if (bt) bt.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

// Smooth scroll
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    const target = document.querySelector(a.getAttribute('href'));
    if (target) { e.preventDefault(); target.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  });
});

// ── Reveal on scroll ─────────────────────────
const revealItems = $$('.bento-card, .tut-card, .cmd-card, .social-card, .install-step, .skill-row, .tut-card');
revealItems.forEach(el => el.classList.add('reveal'));

const ro = new IntersectionObserver(entries => {
  entries.forEach((e, i) => {
    if (e.isIntersecting) {
      setTimeout(() => e.target.classList.add('in'), i * 50);
      ro.unobserve(e.target);
    }
  });
}, { threshold: 0.1, rootMargin: '0px 0px -30px 0px' });
revealItems.forEach(el => ro.observe(el));

// ── Animated counters ────────────────────────
function countUp(el, target) {
  const dur = 1800, fps = 60;
  const steps = Math.floor(dur / (1000 / fps));
  let cur = 0, step = 0;
  const iv = setInterval(() => {
    step++;
    cur = Math.round(target * (step / steps));
    el.textContent = cur;
    if (step >= steps) { el.textContent = target; clearInterval(iv); }
  }, 1000 / fps);
}

const counterObs = new IntersectionObserver(entries => {
  if (entries[0].isIntersecting) {
    $$('.av-num').forEach(el => countUp(el, parseInt(el.dataset.target)));
    counterObs.disconnect();
  }
}, { threshold: 0.5 });
const avStats = document.querySelector('.av-stats');
if (avStats) counterObs.observe(avStats);

// ── Skill bars ───────────────────────────────
const skillObs = new IntersectionObserver(entries => {
  if (entries[0].isIntersecting) {
    $$('.skill-fill').forEach(fill => {
      setTimeout(() => { fill.style.width = fill.dataset.w + '%'; }, 200);
    });
    skillObs.disconnect();
  }
}, { threshold: 0.4 });
const skillsWrap = document.querySelector('.about-skills');
if (skillsWrap) skillObs.observe(skillsWrap);

// ── Command Generator ─────────────────────────
const state = {
  type: 'video', quality: 'best', fmt: 'mp4',
  subs: false, thumb: false, meta: true,
  playlist: false, cookies: false, sponsor: false,
  url: ''
};

const breakdownData = {
  '-x':                       'Extract audio only',
  '--audio-format':            'Set audio format',
  '--audio-quality 0':         'Best audio quality (VBR)',
  '-f "bestvideo+bestaudio"':  'Select best video + audio streams',
  '-f "bestvideo[height<=':    'Limit video resolution',
  '--merge-output-format':     'Set output container format',
  '--write-thumbnail':         'Save video thumbnail',
  '--skip-download':           'Skip video, only get metadata',
  '--write-subs':              'Download subtitle files',
  '--write-auto-subs':         'Download auto-generated subs',
  '--embed-subs':              'Embed subtitles into file',
  '--embed-thumbnail':         'Embed thumbnail into audio file',
  '--add-metadata':            'Embed title, artist, date metadata',
  '--yes-playlist':            'Download entire playlist',
  '--cookies-from-browser':    'Use browser login cookies',
  '--sponsorblock-mark all':   'Mark sponsored segments',
};

function buildCmd() {
  const { type, quality, fmt, subs, thumb, meta, playlist, cookies, sponsor, url } = state;
  const parts = ['yt-dlp'];
  const breakdown = [];

  if (type === 'audio') {
    parts.push('-x');
    const af = ['mp3','flac','opus'].includes(fmt) ? fmt : 'mp3';
    parts.push(`--audio-format ${af}`);
    parts.push('--audio-quality 0');
    breakdown.push(['-x', 'Extract audio only']);
    breakdown.push([`--audio-format ${af}`, `Output as ${af.toUpperCase()}`]);
    breakdown.push(['--audio-quality 0', 'Highest quality VBR audio']);
  } else if (type === 'thumbnail') {
    parts.push('--write-thumbnail --skip-download');
    breakdown.push(['--write-thumbnail', 'Save video thumbnail image']);
    breakdown.push(['--skip-download', 'Do not download the video']);
  } else if (type === 'subs') {
    parts.push('--write-subs --write-auto-subs --skip-download');
    breakdown.push(['--write-subs', 'Download all subtitle tracks']);
    breakdown.push(['--write-auto-subs', 'Include auto-generated captions']);
    breakdown.push(['--skip-download', 'Skip video file']);
  } else {
    // video
    if (quality === 'best') {
      parts.push('-f "bestvideo+bestaudio"');
      breakdown.push(['-f "bestvideo+bestaudio"', 'Best quality video + audio']);
    } else {
      parts.push(`-f "bestvideo[height<=${quality}]+bestaudio"`);
      breakdown.push([`-f "bestvideo[height<=${quality}]..."`, `Max ${quality}p resolution`]);
    }
    const mfmt = ['mp4','mkv','webm'].includes(fmt) ? fmt : 'mp4';
    parts.push(`--merge-output-format ${mfmt}`);
    breakdown.push([`--merge-output-format ${mfmt}`, `Output in ${mfmt.toUpperCase()} container`]);
  }

  if (subs && type !== 'subs')     { parts.push('--embed-subs --write-auto-subs'); breakdown.push(['--embed-subs', 'Embed subtitles into video']); }
  if (thumb && type !== 'thumbnail'){ parts.push('--embed-thumbnail'); breakdown.push(['--embed-thumbnail', 'Embed cover art']); }
  if (meta)                         { parts.push('--add-metadata'); breakdown.push(['--add-metadata', 'Embed title, date, uploader']); }
  if (playlist)                     { parts.push('--yes-playlist'); breakdown.push(['--yes-playlist', 'Download all playlist items']); }
  if (cookies)                      { parts.push('--cookies-from-browser chrome'); breakdown.push(['--cookies-from-browser chrome', 'Use Chrome login cookies']); }
  if (sponsor)                      { parts.push('--sponsorblock-mark all'); breakdown.push(['--sponsorblock-mark all', 'Flag sponsored segments']); }

  const urlPart = url.trim() || '<URL>';
  parts.push(urlPart);

  return { cmd: parts.join(' '), breakdown };
}

function renderCmd() {
  const { cmd, breakdown } = buildCmd();
  $('gen-cmd-output').textContent = cmd;

  const bl = $('breakdown-list');
  if (bl) {
    bl.innerHTML = breakdown.map(([flag, desc]) =>
      `<div class="breakdown-item"><span class="bi-flag">${flag}</span><span class="bi-desc">— ${desc}</span></div>`
    ).join('');
  }
}

// Pill interactions
$$('.gpill').forEach(pill => {
  pill.addEventListener('click', () => {
    const g = pill.dataset.g;
    $$('.gpill').filter(p => p.dataset.g === g).forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    state[g] = pill.dataset.v;
    if (g === 'type' && pill.dataset.v === 'audio') {
      $$('.gpill[data-g="fmt"]').forEach(p => p.classList.remove('active'));
      const mp3 = document.querySelector('.gpill[data-v="mp3"]');
      if (mp3) { mp3.classList.add('active'); state.fmt = 'mp3'; }
    }
    renderCmd();
  });
});

// Toggle interactions
[
  ['gt-subs-chk',     'subs'],
  ['gt-thumb-chk',    'thumb'],
  ['gt-meta-chk',     'meta'],
  ['gt-playlist-chk', 'playlist'],
  ['gt-cookies-chk',  'cookies'],
  ['gt-sponsor-chk',  'sponsor'],
].forEach(([id, key]) => {
  const el = $(id);
  if (el) el.addEventListener('change', () => { state[key] = el.checked; renderCmd(); });
});

// URL input
const genUrl = $('gen-url');
if (genUrl) {
  genUrl.addEventListener('input', () => { state.url = genUrl.value; renderCmd(); });
  $('gen-url-clear').addEventListener('click', () => { genUrl.value = ''; state.url = ''; renderCmd(); genUrl.focus(); });
}

renderCmd();

// ── Clipboard ────────────────────────────────
function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    showToast();
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = '✓ Copied!';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 2000);
    }
  }).catch(() => {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    Object.assign(ta.style, { position: 'fixed', left: '-9999px' });
    document.body.appendChild(ta);
    ta.select(); document.execCommand('copy');
    document.body.removeChild(ta);
    showToast();
  });
}

// Generator copy
const tbarCopy = $('tbar-copy');
if (tbarCopy) {
  tbarCopy.addEventListener('click', () => {
    copyText($('gen-cmd-output').textContent, tbarCopy);
  });
}

// Command cards copy
$$('.cmd-copy').forEach(btn => {
  btn.addEventListener('click', () => copyText(btn.dataset.cmd, btn));
});

// ── Toast ────────────────────────────────────
function showToast() {
  const t = $('toast');
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// ── Tutorial card click ──────────────────────
$$('.tut-card').forEach(card => {
  card.addEventListener('click', () => {
    // Simulated interaction — navigate to relevant guide
    const t = card.querySelector('h4')?.textContent || '';
    console.log('Tutorial clicked:', t);
  });
});
