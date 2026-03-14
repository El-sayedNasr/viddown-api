const express = require('express');
const cors    = require('cors');
const https   = require('https');
const http    = require('http');
const { URL } = require('url');

let ytdl;
try { ytdl = require('@distube/ytdl-core'); } catch(_) { ytdl = null; }

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// Health
app.get('/', (_, res) => res.json({ ok: true, service: 'VidDown API' }));

// ══════════════════════════════════════════════
//  INFO
// ══════════════════════════════════════════════
app.get('/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.json({});
  try {
    const d = await fetchJSON('https://noembed.com/embed?url=' + encodeURIComponent(url));
    res.json({ title: d.title || '', author: d.author_name || '', thumbnail: d.thumbnail_url || '' });
  } catch(_) { res.json({ title:'', author:'', thumbnail:'' }); }
});

// ══════════════════════════════════════════════
//  YOUTUBE — stream مباشر بدون تخزين
// ══════════════════════════════════════════════
app.get('/youtube', async (req, res) => {
  const { url, quality = '720', format = 'mp4' } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });

  const vid = extractYTId(url);
  if (!vid) return res.status(400).json({ error: 'invalid url' });

  const filename = `yt_${vid}_${quality}.${format}`;

  // ── ytdl-core (الأفضل) ──────────────────────
  if (ytdl) {
    try {
      const info    = await ytdl.getInfo(`https://www.youtube.com/watch?v=${vid}`);
      const formats = ytdl.filterFormats(info.formats, format === 'mp3' ? 'audioonly' : 'videoandaudio');

      let chosen;
      if (format === 'mp3') {
        chosen = formats.sort((a,b) => (b.audioBitrate||0)-(a.audioBitrate||0))[0];
      } else {
        const targetH = parseInt(quality);
        const withAudio = formats.filter(f => f.hasAudio && f.hasVideo);
        chosen = withAudio.find(f => parseInt(f.qualityLabel) === targetH)
              || withAudio.sort((a,b) => Math.abs(parseInt(a.qualityLabel)-targetH) - Math.abs(parseInt(b.qualityLabel)-targetH))[0]
              || formats[0];
      }

      if (!chosen) throw new Error('no_format');

      const mime = format === 'mp3' ? 'audio/mpeg' : 'video/mp4';
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', mime);
      res.setHeader('Access-Control-Allow-Origin', '*');

      const stream = ytdl.downloadFromInfo(info, { format: chosen });
      stream.on('error', e => { console.error('[ytdl stream]', e.message); if (!res.headersSent) res.status(500).end(); });
      stream.pipe(res);
      return;

    } catch(e) {
      console.error('[ytdl]', e.message);
      // fallback below
    }
  }

  // ── Invidious fallback ───────────────────────
  try {
    const streamUrl = await getInvidiousStream(vid, format, quality);
    if (!streamUrl) throw new Error('no_stream');
    return proxyStream(streamUrl, filename, format, res);
  } catch(e) {
    console.error('[invidious]', e.message);
    return res.status(503).json({ error: 'no_stream_found' });
  }
});

// ══════════════════════════════════════════════
//  TIKTOK
// ══════════════════════════════════════════════
app.get('/tiktok', async (req, res) => {
  const { url, format = 'mp4' } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });

  const filename = `tt_${Date.now()}.${format}`;

  // TikWM
  try {
    const streamUrl = await getTikWMStream(url, format);
    if (!streamUrl) throw new Error('no_stream');
    return proxyStream(streamUrl, filename, format, res);
  } catch(e) {
    console.error('[tiktok]', e.message);
    // Cobalt fallback
    try {
      const cobaltUrl = await tryCobalt(url, '1080', format);
      if (!cobaltUrl) throw new Error('no_cobalt');
      return proxyStream(cobaltUrl, filename, format, res);
    } catch(_) {
      return res.status(503).json({ error: 'no_stream_found' });
    }
  }
});

// ══════════════════════════════════════════════
//  Proxy stream — pipe URL → client
// ══════════════════════════════════════════════
function proxyStream(url, filename, format, res) {
  const mime = format === 'mp3' ? 'audio/mpeg'
             : format === 'mp4' ? 'video/mp4'
             : 'application/octet-stream';

  const parsed = new URL(url);
  const lib    = parsed.protocol === 'https:' ? https : http;

  const options = {
    hostname: parsed.hostname,
    port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path:     parsed.pathname + parsed.search,
    method:   'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept':     '*/*',
      'Referer':    'https://www.youtube.com/',
    }
  };

  lib.get(options, (upstream) => {
    if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
      return proxyStream(upstream.headers.location, filename, format, res);
    }
    if (upstream.statusCode < 200 || upstream.statusCode >= 400) {
      if (!res.headersSent) res.status(upstream.statusCode).json({ error: 'upstream_error' });
      return;
    }
    if (!res.headersSent) {
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (upstream.headers['content-length'])
        res.setHeader('Content-Length', upstream.headers['content-length']);
    }
    upstream.pipe(res);
  }).on('error', e => {
    console.error('[proxy]', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'proxy_error' });
  });
}

// ══════════════════════════════════════════════
//  Invidious
// ══════════════════════════════════════════════
const INVIDIOUS = [
  'https://inv.tux.pizza',
  'https://invidious.privacyredirect.com',
  'https://invidious.fdn.fr',
  'https://y.com.sb',
];

async function getInvidiousStream(videoId, format, quality) {
  const targetH = parseInt(quality) || 720;
  for (const base of INVIDIOUS) {
    try {
      const data = await fetchJSON(`${base}/api/v1/videos/${videoId}?fields=adaptiveFormats,formatStreams`, {}, 10000);
      if (!data || data.error) continue;
      if (format === 'mp3') {
        const a = (data.adaptiveFormats||[]).filter(f=>f.type&&f.type.includes('audio/')).sort((a,b)=>(b.bitrate||0)-(a.bitrate||0));
        if (a[0]?.url) return a[0].url;
      } else {
        const combined = (data.formatStreams||[]).filter(f=>f.url&&f.type&&f.type.includes('video/')).map(f=>({...f,h:parseInt(f.resolution||'0')})).sort((a,b)=>Math.abs(a.h-targetH)-Math.abs(b.h-targetH));
        if (combined[0]?.url) return combined[0].url;
      }
    } catch(_) { continue; }
  }
  return null;
}

// ══════════════════════════════════════════════
//  TikWM
// ══════════════════════════════════════════════
async function getTikWMStream(videoUrl, format) {
  const data = await fetchJSON('https://www.tikwm.com/api/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'url=' + encodeURIComponent(videoUrl) + '&hd=1',
  }, 12000);
  if (!data || data.code !== 0 || !data.data) return null;
  return format === 'mp3' ? (data.data.music || null) : (data.data.hdplay || data.data.play || null);
}

// ══════════════════════════════════════════════
//  Cobalt
// ══════════════════════════════════════════════
async function tryCobalt(url, quality, format) {
  for (const base of ['https://api.cobalt.tools/', 'https://co.wuk.sh/']) {
    try {
      const data = await fetchJSON(base, {
        method: 'POST',
        headers: { 'Accept':'application/json','Content-Type':'application/json' },
        body: JSON.stringify({ url, videoQuality:String(quality), audioFormat:'mp3', filenameStyle:'basic', downloadMode:format==='mp3'?'audio':'auto', tiktokH265:false }),
      }, 9000);
      if (!data||data.status==='error') continue;
      if (data.status==='redirect'||data.status==='tunnel') return data.url;
      if (data.status==='picker'&&data.picker?.length) return (data.picker.find(p=>p.type==='video')||data.picker[0])?.url||null;
    } catch(_) { continue; }
  }
  return null;
}

// ══════════════════════════════════════════════
//  fetchJSON helper
// ══════════════════════════════════════════════
function fetchJSON(url, opts={}, timeout=12000) {
  return new Promise((resolve,reject)=>{
    const { method='GET', headers={}, body } = opts;
    let parsed; try { parsed=new URL(url); } catch(e) { return reject(e); }
    const lib   = parsed.protocol==='https:' ? https : http;
    const timer = setTimeout(()=>reject(new Error('timeout')), timeout);
    const req   = lib.request({
      hostname: parsed.hostname,
      port:     parsed.port||(parsed.protocol==='https:'?443:80),
      path:     parsed.pathname+parsed.search,
      method,
      headers:  { 'User-Agent':'VidDown/5.0','Accept':'application/json', ...headers },
    }, res=>{
      if ([301,302,303,307,308].includes(res.statusCode)&&res.headers.location) {
        clearTimeout(timer);
        const loc=res.headers.location, next=loc.startsWith('http')?loc:`${parsed.protocol}//${parsed.host}${loc}`;
        fetchJSON(next,opts,timeout).then(resolve).catch(reject); return;
      }
      let raw=''; res.setEncoding('utf8');
      res.on('data',c=>raw+=c);
      res.on('end',()=>{ clearTimeout(timer); try{resolve(JSON.parse(raw));}catch(_){reject(new Error('bad_json'));} });
    });
    req.on('error',e=>{clearTimeout(timer);reject(e);});
    if(body) req.write(body);
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

app.listen(PORT, () => console.log(`✅ VidDown server on port ${PORT}`));
