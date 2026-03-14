const express  = require('express');
const cors     = require('cors');
const { execFile } = require('child_process');
const https    = require('https');
const http     = require('http');
const { URL }  = require('url');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/', (_, res) => res.json({ ok: true, service: 'VidDown API v5' }));

// ── Info ──────────────────────────────────────────
app.get('/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.json({});
  try {
    const d = await fetchJSON('https://noembed.com/embed?url=' + encodeURIComponent(url));
    res.json({ title: d.title||'', author: d.author_name||'', thumbnail: d.thumbnail_url||'' });
  } catch(_) { res.json({ title:'', author:'', thumbnail:'' }); }
});

// ════════════════════════════════════════════════
//  YOUTUBE
// ════════════════════════════════════════════════
app.get('/youtube', async (req, res) => {
  const { url, quality='720', format='mp4' } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });

  const vid   = extractYTId(url);
  if (!vid)   return res.status(400).json({ error: 'invalid url' });

  const ytUrl = `https://www.youtube.com/watch?v=${vid}`;
  const ext   = format === 'mp3' ? 'mp3' : 'mp4';
  const tmpFile = path.join(os.tmpdir(), `yt_${vid}_${Date.now()}.${ext}`);
  const fname   = `yt_${vid}_${quality}.${ext}`;

  // ── Build yt-dlp args ─────────────────────────
  let args;

  if (format === 'mp3') {
    // صوت فقط — -x بتعمل extract audio بدون merge
    args = [
      '--no-playlist', '--no-warnings',
      '-f', 'bestaudio[ext=m4a]/bestaudio/best',
      '-x', '--audio-format', 'mp3', '--audio-quality', '0',
      '-o', tmpFile,
      '--no-part', '--retries', '3', '--socket-timeout', '30',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0',
      '--extractor-args', 'youtube:player_client=android,web',
      ytUrl
    ];
  } else {
    // فيديو + صوت mp4
    args = [
      '--no-playlist', '--no-warnings',
      '-f', `bestvideo[height<=${quality}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${quality}][ext=mp4]/best[height<=${quality}]/best`,
      '--merge-output-format', 'mp4',
      '-o', tmpFile,
      '--no-part', '--retries', '3', '--socket-timeout', '30',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0',
      '--extractor-args', 'youtube:player_client=android,web',
      ytUrl
    ];
  }

  console.log(`[YT] vid=${vid} quality=${quality} format=${format}`);

  try {
    const outFile = await runYtDlp(args, vid, ext);

    const mime = format === 'mp3' ? 'audio/mpeg' : 'video/mp4';
    const stat = fs.statSync(outFile);

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Access-Control-Allow-Origin', '*');

    const stream = fs.createReadStream(outFile);
    stream.pipe(res);
    stream.on('close', () => { try { fs.unlinkSync(outFile); } catch(_) {} });

  } catch(e) {
    console.error('[YT error]', e.message);
    cleanTmp(vid);
    if (!res.headersSent) res.status(503).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════
//  TIKTOK
// ════════════════════════════════════════════════
app.get('/tiktok', async (req, res) => {
  const { url, format='mp4' } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });

  const fname = `tt_${Date.now()}.${format}`;
  try {
    const streamUrl = await getTikWMStream(url, format)
                   || await tryCobalt(url, '1080', format);
    if (!streamUrl) return res.status(503).json({ error: 'no_stream_found' });
    proxyStream(streamUrl, fname, format, res);
  } catch(e) {
    if (!res.headersSent) res.status(503).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════
//  runYtDlp — يشغّل yt-dlp ويرجع مسار الملف
// ════════════════════════════════════════════════
function runYtDlp(args, vid, ext) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 120000);

    execFile('yt-dlp', args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      clearTimeout(timer);

      if (err) {
        const msg = (stderr || err.message || '').slice(0, 200);
        console.error('[yt-dlp]', msg);
        return reject(new Error('yt_dlp_failed: ' + msg.slice(0, 80)));
      }

      // إيجاد الملف الناتج في /tmp
      const dir = os.tmpdir();
      try {
        const files = fs.readdirSync(dir)
          .filter(f => f.startsWith(`yt_${vid}`) && f.endsWith(`.${ext}`))
          .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
          .sort((a, b) => b.t - a.t);

        if (files.length) return resolve(path.join(dir, files[0].f));
      } catch(_) {}

      reject(new Error('output_not_found'));
    });
  });
}

function cleanTmp(vid) {
  try {
    const dir = os.tmpdir();
    fs.readdirSync(dir)
      .filter(f => f.startsWith(`yt_${vid}`))
      .forEach(f => { try { fs.unlinkSync(path.join(dir, f)); } catch(_) {} });
  } catch(_) {}
}

// ════════════════════════════════════════════════
//  Proxy stream
// ════════════════════════════════════════════════
function proxyStream(url, filename, format, res) {
  const mime = format === 'mp3' ? 'audio/mpeg' : 'video/mp4';
  let parsed; try { parsed = new URL(url); } catch(_) { return res.status(400).end(); }
  const lib = parsed.protocol === 'https:' ? https : http;
  lib.get({
    hostname: parsed.hostname,
    port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path:     parsed.pathname + parsed.search,
    headers:  { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' }
  }, (up) => {
    if (up.statusCode >= 300 && up.statusCode < 400 && up.headers.location)
      return proxyStream(up.headers.location, filename, format, res);
    if (!res.headersSent) {
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (up.headers['content-length']) res.setHeader('Content-Length', up.headers['content-length']);
    }
    up.pipe(res);
  }).on('error', () => { if (!res.headersSent) res.status(500).end(); });
}

// ════════════════════════════════════════════════
//  TikWM
// ════════════════════════════════════════════════
async function getTikWMStream(videoUrl, format) {
  try {
    const data = await fetchJSON('https://www.tikwm.com/api/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'url=' + encodeURIComponent(videoUrl) + '&hd=1',
    }, 12000);
    if (!data || data.code !== 0 || !data.data) return null;
    return format === 'mp3' ? (data.data.music || null) : (data.data.hdplay || data.data.play || null);
  } catch(_) { return null; }
}

// ════════════════════════════════════════════════
//  Cobalt
// ════════════════════════════════════════════════
async function tryCobalt(url, quality, format) {
  for (const base of ['https://api.cobalt.tools/', 'https://co.wuk.sh/']) {
    try {
      const data = await fetchJSON(base, {
        method: 'POST',
        headers: { 'Accept':'application/json', 'Content-Type':'application/json' },
        body: JSON.stringify({ url, videoQuality:String(quality), audioFormat:'mp3',
          filenameStyle:'basic', downloadMode:format==='mp3'?'audio':'auto', tiktokH265:false }),
      }, 9000);
      if (!data || data.status === 'error') continue;
      if (data.status === 'redirect' || data.status === 'tunnel') return data.url;
      if (data.status === 'picker' && data.picker?.length)
        return (data.picker.find(p=>p.type==='video') || data.picker[0])?.url || null;
    } catch(_) { continue; }
  }
  return null;
}

// ════════════════════════════════════════════════
//  fetchJSON
// ════════════════════════════════════════════════
function fetchJSON(url, opts={}, timeout=12000) {
  return new Promise((resolve, reject) => {
    const { method='GET', headers={}, body } = opts;
    let parsed; try { parsed = new URL(url); } catch(e) { return reject(e); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const timer = setTimeout(() => reject(new Error('timeout')), timeout);
    const req = lib.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method,
      headers: { 'User-Agent':'VidDown/5.0', 'Accept':'application/json', ...headers },
    }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        clearTimeout(timer);
        const loc = res.headers.location;
        fetchJSON(loc.startsWith('http') ? loc : `${parsed.protocol}//${parsed.host}${loc}`, opts, timeout).then(resolve).catch(reject);
        return;
      }
      let raw = ''; res.setEncoding('utf8');
      res.on('data', c => raw += c);
      res.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(raw)); } catch(_) { reject(new Error('bad_json')); } });
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
    if (body) req.write(body);
    req.end();
  });
}

function extractYTId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1).split(/[?&]/)[0];
    if (u.pathname.includes('/shorts/'))  return u.pathname.split('/shorts/')[1].split(/[/?]/)[0];
    return u.searchParams.get('v') || '';
  } catch(_) {}
  const m = url.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/);
  return m ? m[1] : '';
}

app.listen(PORT, () => console.log(`✅ VidDown v5 on port ${PORT}`));
