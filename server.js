const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const PORT = 3777;

// Template native size and the purple-square hole inside it (px, 944x1680 base).
// The output geometry is scaled from these for each export resolution.
const NAT = { w: 944, h: 1680 };
const HOLE = { left: 50, top: 481, right: 897, bottom: 1267 };
const SIZES = { 1080: { w: 1080, h: 1920 }, 2160: { w: 2160, h: 3840 } };

// The client already computed the exact integer, even-sized rect for the chosen
// resolution (identical math on both sides) and sends it verbatim, so the video
// and the overlay hole line up to the pixel. We only validate and clamp here.
function videoRect(outW, outH, body) {
  let x = parseInt(body.vx, 10), y = parseInt(body.vy, 10);
  let w = parseInt(body.vw, 10), h = parseInt(body.vh, 10);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
    const fx = outW / NAT.w, fy = outH / NAT.h;
    x = Math.round(HOLE.left * fx); y = Math.round(HOLE.top * fy);
    w = Math.round((HOLE.right - HOLE.left) * fx); h = Math.round((HOLE.bottom - HOLE.top) * fy);
  }
  if (w % 2) w++;
  if (h % 2) h++;
  w = Math.min(w, outW); h = Math.min(h, outH);
  x = Math.max(0, Math.min(x, outW - w));
  y = Math.max(0, Math.min(y, outH - h));
  return { x, y, w, h };
}

const even = n => { n = Math.ceil(n); return n % 2 ? n + 1 : n; };

const app = express();
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, p) => {
    // always revalidate assets so template swaps show up immediately
    if (p.endsWith('.png') || p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

const uploadsDir = path.join(__dirname, 'uploads');
const outputDir = path.join(__dirname, 'output');
for (const d of [uploadsDir, outputDir]) if (!fs.existsSync(d)) fs.mkdirSync(d);

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB
});

const jobs = new Map(); // id -> { state, percent, error, outFile }

// ---------- presets (4 layout slots; the site opens on the last used one) ----------
const presetsFile = path.join(__dirname, 'presets.json');
app.use(express.json({ limit: '2mb' }));

function readPresets() {
  try {
    const d = JSON.parse(fs.readFileSync(presetsFile, 'utf8'));
    if (d && typeof d === 'object' && d.slots) return d;
  } catch (e) {}
  return { slots: {}, lastSlot: null };
}
function writePresets(d) {
  fs.writeFileSync(presetsFile, JSON.stringify(d, null, 2));
}

app.get('/presets', (req, res) => res.json(readPresets()));

app.put('/presets/last', (req, res) => {
  const d = readPresets();
  const n = String(req.body && req.body.slot);
  if (d.slots[n]) { d.lastSlot = n; writePresets(d); }
  res.json({ ok: true });
});

app.post('/presets/:slot', (req, res) => {
  const n = String(req.params.slot);
  if (!['1', '2', '3', '4'].includes(n)) return res.status(400).json({ error: 'slot inválido' });
  try {
    const d = readPresets();
    d.slots[n] = req.body;
    d.lastSlot = n;
    writePresets(d);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/presets/:slot', (req, res) => {
  const d = readPresets();
  delete d.slots[String(req.params.slot)];
  if (String(d.lastSlot) === String(req.params.slot)) d.lastSlot = null;
  writePresets(d);
  res.json({ ok: true });
});

// ---------- custom logo photo upload ----------
const assetsDir = path.join(__dirname, 'public', 'assets');
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir);

app.post('/upload-logo', upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'nenhuma foto enviada' });
  const extMap = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
  const ext = extMap[req.file.mimetype] || '.png';
  const name = 'logo_' + crypto.randomBytes(6).toString('hex') + ext;
  fs.copyFileSync(req.file.path, path.join(assetsDir, name));
  fs.unlink(req.file.path, () => {});
  res.json({ url: '/assets/' + name });
});

app.post('/render', upload.fields([{ name: 'video', maxCount: 1 }, { name: 'overlay', maxCount: 1 }]), (req, res) => {
  const video = req.files && req.files.video && req.files.video[0];
  const overlay = req.files && req.files.overlay && req.files.overlay[0];
  if (!video || !overlay) return res.status(400).json({ error: 'video e overlay são obrigatórios' });

  const size = SIZES[req.body.width] || SIZES[1080];
  const id = crypto.randomBytes(8).toString('hex');
  const outFile = path.join(outputDir, id + '.mp4');
  const job = { state: 'rendering', percent: 0, error: null, outFile };
  jobs.set(id, job);

  const { x, y, w, h } = videoRect(size.w, size.h, req.body);

  // crop controls: zoom (>=1) and focal point panx/pany in [0,1] (0.5 = center)
  let zoom = parseFloat(req.body.zoom);
  let panx = parseFloat(req.body.panx);
  let pany = parseFloat(req.body.pany);
  if (!Number.isFinite(zoom) || zoom < 1) zoom = 1;
  if (zoom > 5) zoom = 5;
  if (!Number.isFinite(panx)) panx = 0.5;
  if (!Number.isFinite(pany)) pany = 0.5;
  panx = Math.min(Math.max(panx, 0), 1);
  pany = Math.min(Math.max(pany, 0), 1);

  // Cover a box of (w*zoom)x(h*zoom) keeping aspect, then window out a w x h crop
  // at the focal point. Zoom=1 & pan=0.5 => plain centred "cover" fill.
  const boxW = even(w * zoom), boxH = even(h * zoom);
  const filter =
    `[0:v]scale=${boxW}:${boxH}:force_original_aspect_ratio=increase,` +
    `crop=${w}:${h}:(iw-${w})*${panx.toFixed(4)}:(ih-${h})*${pany.toFixed(4)},setsar=1,` +
    `pad=${size.w}:${size.h}:${x}:${y}:black[base];[base][1:v]overlay=0:0[out]`;

  const args = [
    '-y',
    '-i', video.path,
    '-i', overlay.path,
    '-filter_complex', filter,
    '-map', '[out]', '-map', '0:a?',
    '-c:v', 'libx264', '-crf', '17', '-preset', 'fast',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    outFile,
  ];

  const proc = spawn(ffmpegPath, args);
  let durationSec = 0;
  let stderrTail = '';
  proc.stderr.on('data', (chunk) => {
    const s = chunk.toString();
    stderrTail = (stderrTail + s).slice(-4000);
    const dur = s.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
    if (dur && !durationSec) durationSec = (+dur[1]) * 3600 + (+dur[2]) * 60 + (+dur[3]);
    const t = s.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
    if (t && durationSec) {
      const cur = (+t[1]) * 3600 + (+t[2]) * 60 + (+t[3]);
      job.percent = Math.min(99, Math.round((cur / durationSec) * 100));
    }
  });
  proc.on('error', (err) => {
    job.state = 'error';
    job.error = 'Falha ao iniciar o FFmpeg: ' + err.message;
  });
  proc.on('close', (code) => {
    fs.unlink(video.path, () => {});
    fs.unlink(overlay.path, () => {});
    if (code === 0) {
      job.state = 'done';
      job.percent = 100;
    } else if (job.state !== 'error') {
      job.state = 'error';
      job.error = 'FFmpeg saiu com código ' + code + '\n' + stderrTail;
      console.error('FFmpeg error (job ' + id + '):\n' + stderrTail);
    }
  });

  res.json({ id });
});

app.get('/progress/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job não encontrado' });
  res.json({ state: job.state, percent: job.percent, error: job.error });
});

app.get('/download/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.state !== 'done') return res.status(404).send('Arquivo não pronto');
  res.download(job.outFile, 'post-stm-' + req.params.id.slice(0, 6) + '.mp4');
});

// remove renders/uploads older than 24h so the disk doesn't fill up
for (const dir of [outputDir, uploadsDir]) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > 24 * 3600 * 1000) fs.unlinkSync(p);
    } catch (e) {}
  }
}

app.listen(PORT, () => {
  console.log('STM Video Editor rodando em http://localhost:' + PORT);
});
