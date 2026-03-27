'use strict';

const path    = require('path');
const express = require('express');
const multer  = require('multer');
const { Storage } = require('@google-cloud/storage');

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

const gcs        = new Storage(buildStorageOptions());
const BUCKET     = process.env.GCS_BUCKET_NAME || 'archiveomi-files';
const bucket     = gcs.bucket(BUCKET);

// ── Express setup ──────────────────────────────────────────────────────────
const app    = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 512 * 1024 * 1024 }   // 512 MB per file
});

app.use(express.json());

// Serve static files only from the /public directory (not the project root)
app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  extensions: ['html']
}));

// ── Helper: safe object name (keep original name, strip path traversal) ───
function safeName(original) {
  const base = path.basename(original).replace(/[^\w.\-]/g, '_');
  // reject names that are only dots (e.g. "..", ".")
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
    // newest first
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
        resumable:    false,
        contentType:  f.mimetype,
        metadata:     { contentType: f.mimetype }
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

// ── Stream / proxy a file from GCS ─────────────────────────────────────────
app.get('/files/:name(*)', async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  try {
    const obj = bucket.file(name);
    const [exists] = await obj.exists();
    if (!exists) return res.status(404).send('Not found');

    const [meta] = await obj.getMetadata();
    const ct = meta.contentType || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    if (meta.size) res.setHeader('Content-Length', meta.size);
    // inline for preview; add ?dl=1 to force download
    if (req.query.dl) {
      // RFC 6266: encode filename to prevent header injection
      const safeFn = name.replace(/[\\"/]/g, '_');
      res.setHeader('Content-Disposition', `attachment; filename="${safeFn}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    }
    obj.createReadStream().pipe(res);
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

// ── Waifu proxy + background removal ──────────────────────────────────────
// Cache the dynamic ESM import so the ONNX models are only initialised once.
let _removeBackground;
async function getRemoveBackground() {
  if (!_removeBackground) {
    const mod = await import('@imgly/background-removal-node');
    _removeBackground = mod.removeBackground;
  }
  return _removeBackground;
}

app.get('/api/waifu', async (_req, res) => {
  try {
    const apiRes = await fetch('https://api.waifu.pics/sfw/waifu');
    if (!apiRes.ok) return res.status(502).json({ error: 'waifu.pics unavailable' });
    const { url } = await apiRes.json();
    if (!url) return res.status(502).json({ error: 'No image URL from waifu.pics' });

    const removeBackground = await getRemoveBackground();
    const blob = await removeBackground(url);

    const buf = Buffer.from(await blob.arrayBuffer());
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (err) {
    console.error('waifu bg-remove error', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`ArchiveOMI running at http://localhost:${PORT}`);
  console.log(`GCS bucket: ${BUCKET}`);
});
