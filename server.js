'use strict';

const path     = require('path');
const { Readable } = require('node:stream');
const express  = require('express');
const multer   = require('multer');
const { Storage } = require('@google-cloud/storage');
const { removeBackground } = require('@imgly/background-removal-node');

// ── Load .env if present ───────────────────────────────────────────────────
try { require('fs').readFileSync('.env').toString().split('\n').forEach(line => {
  const m = line.match(/^([A-Z_]+)\s*=\s*(.+)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}); } catch (_) {}

// ── GCS credentials ────────────────────────────────────────────────────────
function buildStorageOptions() {
  if (process.env.GCS_SERVICE_ACCOUNT_JSON) {
    return { credentials: JSON.parse(process.env.GCS_SERVICE_ACCOUNT_JSON) };
  }
  const keyFile = process.env.GCS_KEY_FILE || path.join(__dirname, 'service-account.json');
  return { keyFilename: keyFile };
}

const gcs    = new Storage(buildStorageOptions());
const BUCKET = process.env.GCS_BUCKET_NAME || 'archiveomi-files';
const bucket = gcs.bucket(BUCKET);

// ── Express setup ──────────────────────────────────────────────────────────
const app    = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 512 * 1024 * 1024 }   // 512 MB per file
});

app.use(express.json());

// ── COOP/COEP headers (required for SharedArrayBuffer / WASM) ──────────────
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  next();
});

// Serve static files only from the /public directory
app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  extensions: ['html']
}));

// ── Helper: safe object name ───────────────────────────────────────────────
function safeName(original) {
  const base = path.basename(original).replace(/[^\w.\-]/g, '_');
  if (/^\.+$/.test(base) || base.length === 0) return '_file';
  return base;
}

// ── List files ─────────────────────────────────────────────────────────────
app.get('/api/files', async (_req, res) => {
  try {
    const [files] = await bucket.getFiles();
    const list = files.map(f => ({
      name:        f.name,
      size:        Number(f.metadata.size  || 0),
      type:        f.metadata.contentType  || 'application/octet-stream',
      timeCreated: f.metadata.timeCreated  || null,
      url:         `/files/${encodeURIComponent(f.name)}`
    }));
    list.sort((a, b) => (b.timeCreated || '').localeCompare(a.timeCreated || ''));
    res.json(list);
  } catch (err) {
    console.error('list error', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Upload files ───────────────────────────────────────────────────────────
app.post('/api/upload', upload.array('files', 50), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files provided' });
  }
  try {
    const results = await Promise.all(req.files.map(async f => {
      const name = safeName(f.originalname);
      const obj  = bucket.file(name);
      await obj.save(f.buffer, {
        resumable:   false,
        contentType: f.mimetype,
        metadata:    { contentType: f.mimetype }
      });
      return {
        name,
        size: f.size,
        type: f.mimetype,
        url:  `/files/${encodeURIComponent(name)}`
      };
    }));
    res.json(results);
  } catch (err) {
    console.error('upload error', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Stream / proxy a file from GCS with range support ─────────────────────
app.get('/files/:name(*)', async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  try {
    const obj = bucket.file(name);
    const [exists] = await obj.exists();
    if (!exists) return res.status(404).send('Not found');

    const [meta] = await obj.getMetadata();
    const ct   = meta.contentType || 'application/octet-stream';
    const size = Number(meta.size || 0);

    // Cache headers
    if (ct.startsWith('image/') || ct.startsWith('video/') || ct.startsWith('audio/')) {
      res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
      const etag = `"${meta.etag || meta.md5Hash || name}"`;
      res.setHeader('ETag', etag);
      if (meta.timeCreated) res.setHeader('Last-Modified', new Date(meta.timeCreated).toUTCString());
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }

    // Force download
    if (req.query.dl) {
      const safeFn = name.replace(/[\\"/]/g, '_');
      res.setHeader('Content-Disposition', `attachment; filename="${safeFn}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    }

    res.setHeader('Content-Type', ct);
    res.setHeader('Accept-Ranges', 'bytes');

    // ── Range request (video seeking) ──────────────────────────
    const range = req.headers.range;
    if (range && size) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end   = endStr ? parseInt(endStr, 10) : Math.min(start + 10 * 1024 * 1024, size - 1);

      if (start >= size || end >= size) {
        res.setHeader('Content-Range', `bytes */${size}`);
        return res.status(416).send('Range Not Satisfiable');
      }

      res.setHeader('Content-Range',  `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', end - start + 1);
      res.status(206);
      obj.createReadStream({ start, end }).pipe(res);
    } else {
      if (size) res.setHeader('Content-Length', size);
      obj.createReadStream().pipe(res);
    }
  } catch (err) {
    console.error('stream error', err.message);
    res.status(500).send(err.message);
  }
});

// ── Delete a file ──────────────────────────────────────────────────────────
app.delete('/api/files/:name(*)', async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  try {
    await bucket.file(name).delete();
    res.json({ success: true });
  } catch (err) {
    console.error('delete error', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Background removal ─────────────────────────────────────────────────────
app.post('/api/remove-bg', upload.single('image'), async (req, res) => {
  try {
    let input;
    if (req.file) {
      input = new Blob([req.file.buffer], { type: req.file.mimetype });
    } else if (req.body && req.body.url) {
      input = req.body.url;
    } else {
      return res.status(400).json({ error: 'No image provided' });
    }
    const blob   = await removeBackground(input);
    const buffer = Buffer.from(await blob.arrayBuffer());
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (err) {
    console.error('remove-bg error', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Waifu proxy ────────────────────────────────────────────────────────────
app.get('/api/waifu', async (_req, res) => {
  try {
    const apiRes = await fetch('https://api.waifu.pics/sfw/waifu');
    if (!apiRes.ok) return res.status(502).json({ error: 'waifu.pics unavailable' });
    const { url } = await apiRes.json();
    if (!url) return res.status(502).json({ error: 'No image URL from waifu.pics' });

    const imgRes = await fetch(url);
    if (!imgRes.ok) return res.status(502).json({ error: 'Failed to fetch image' });

    res.setHeader('Content-Type', imgRes.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    Readable.fromWeb(imgRes.body).pipe(res);
  } catch (err) {
    console.error('waifu proxy error', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`ArchiveOMI running at http://localhost:${PORT}`);
  console.log(`GCS bucket: ${BUCKET}`);
});
