// Local emulator for Worker API: stores objects under ./local_storage by key
// Usage: node local-server.js [port] [storage_dir]  e.g. node local-server.js 8787 ./local_storage

const express = require('express');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');

const app = express();
const argv = process.argv.slice(2);
const PORT = parseInt(argv[0] || process.env.PORT || 8787, 10);
const STORAGE_DIR = path.resolve(argv[1] || process.env.STORAGE_DIR || path.join(__dirname, 'local_storage'));

function ensureDir(filePath){
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    // recursive option added in Node 10.12+, fallback safe loop for older Node
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      // fallback: iterative create
      const parts = dir.split(path.sep);
      let cur = parts[0] === '' ? path.sep : parts[0];
      for (let i = 1; i < parts.length; i++) {
        cur = path.join(cur, parts[i]);
        if (!fs.existsSync(cur)) {
          fs.mkdirSync(cur);
        }
      }
    }
  }
}

// raw body for uploads
app.use((req, res, next) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// Serve static files from this folder (so GET / serves index.html)
const staticRoot = path.join(__dirname); // serves /home/jiaoyuan/work/flow/*
app.use(express.static(staticRoot));
// Optional explicit index fallback
app.get('/', (req, res) => {
  res.sendFile(path.join(staticRoot, 'index.html'));
});

// For JSON PUT/POST parsing
app.use('/json', bodyParser.json({ limit: '200mb', strict: false }));

// For raw binary PUT uploads
app.put('/upload', express.raw({ type: '*/*', limit: '200mb' }), (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).json({ error: 'missing key' });
  const dest = path.join(STORAGE_DIR, key);
  ensureDir(dest);
  try {
    fs.writeFileSync(dest, req.body);
    // store content-type metadata
    const meta = { contentType: req.headers['content-type'] || 'application/octet-stream' };
    fs.writeFileSync(dest + '.meta.json', JSON.stringify(meta));
    // return a retrieval URL (local)
    const publicUrl = `http://localhost:${PORT}/get?key=${encodeURIComponent(key)}`;
    return res.json({ url: publicUrl });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// GET file
app.get('/get', (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).send('missing key');
  const src = path.join(STORAGE_DIR, key);
  if (!fs.existsSync(src)) return res.status(404).send('Not found');
  const metaPath = src + '.meta.json';
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath,'utf8'));
      if (meta.contentType) res.setHeader('Content-Type', meta.contentType);
    } catch(e){}
  }
  const stream = fs.createReadStream(src);
  stream.on('error', () => res.status(500).end());
  stream.pipe(res);
});

// GET JSON (index)
app.get('/json', (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).json(null);
  const src = path.join(STORAGE_DIR, key);
  if (!fs.existsSync(src)) return res.status(404).json(null);
  try {
    const txt = fs.readFileSync(src, 'utf8');
    return res.json(JSON.parse(txt));
  } catch (e) {
    return res.status(500).json({ error: 'invalid json or read error' });
  }
});

// PUT JSON (index)
app.put('/json', (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).json({ error: 'missing key' });
  const dest = path.join(STORAGE_DIR, key);
  ensureDir(dest);
  try {
    const body = JSON.stringify(req.body, null, 2);
    fs.writeFileSync(dest, body, 'utf8');
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// list conversations (reads conversations/index.json if exists)
app.get('/list-conversations', (req, res) => {
  const idx = path.join(STORAGE_DIR, 'conversations', 'index.json');
  if (!fs.existsSync(idx)) return res.json([]);
  try {
    const list = JSON.parse(fs.readFileSync(idx, 'utf8'));
    return res.json(list);
  } catch (e) {
    return res.status(500).json({ error: 'invalid index file' });
  }
});

// DELETE conversation: remove directory under STORAGE_DIR/conversations/<id>
app.delete('/delete-conversation', (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'missing id' });
  const convDir = path.join(STORAGE_DIR, 'conversations', id);
  if (!fs.existsSync(convDir)) return res.status(404).json({ error: 'not found' });
  // remove recursively
  try {
    fs.rmSync(convDir, { recursive: true, force: true });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// POST rename-conversation: body { oldId, newId } -> rename folder
app.post('/rename-conversation', bodyParser.json(), (req, res) => {
  const { oldId, newId } = req.body || {};
  if (!oldId || !newId) return res.status(400).json({ error: 'missing params' });
  const oldDir = path.join(STORAGE_DIR, 'conversations', oldId);
  const newDir = path.join(STORAGE_DIR, 'conversations', newId);
  if (!fs.existsSync(oldDir)) return res.status(404).json({ error: 'old not found' });
  if (fs.existsSync(newDir)) return res.status(409).json({ error: 'new already exists' });
  try {
    fs.mkdirSync(path.dirname(newDir), { recursive: true });
    fs.renameSync(oldDir, newDir);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// GET export conversation: /export?conv=<id> -> returns text/plain export
app.get('/export', (req, res) => {
  const id = req.query.conv;
  if (!id) return res.status(400).send('missing conv id');
  const idx = path.join(STORAGE_DIR, 'conversations', id, 'index.json');
  if (!fs.existsSync(idx)) return res.status(404).send('Not found');
  try {
    const indexObj = JSON.parse(fs.readFileSync(idx, 'utf8'));
    const lines = [];
    lines.push(`Conversation: ${indexObj.title || id}`);
    lines.push(`Sender: ${indexObj.sender || ''}`);
    lines.push('---');
    (indexObj.messages || []).forEach(m => lines.push(`${m.time || ''}\t${m.text || ''}`));
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(lines.join('\n'));
  } catch (e) {
    res.status(500).send(String(e));
  }
});

// DELETE file by key, e.g. /delete-file?key=conversations/<id>/assets/<filename>
app.delete('/delete-file', (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).json({ error: 'missing key' });

  // helpers
  const tryUnlink = (p) => {
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        return true;
      }
    } catch (e) {
      // ignore per-file errors, will surface below if nothing deleted
    }
    return false;
  };

  // Build candidate paths to try
  const candidates = [];
  candidates.push(key); // raw
  try { candidates.push(decodeURIComponent(key)); } catch (e) { /* ignore */ }
  try { candidates.push(encodeURI(key)); } catch (e) { /* ignore */ }

  // Also attempt to derive assets dir and search for matching filenames (loose match)
  const results = [];
  for (const c of candidates) {
    const full = path.join(STORAGE_DIR, c);
    results.push(full);
    // if candidate points inside assets/, try to search the parent dir for similar names
    const parent = path.dirname(full);
    const base = path.basename(full);
    if (fs.existsSync(parent) && fs.statSync(parent).isDirectory()) {
      try {
        const files = fs.readdirSync(parent);
        for (const f of files) {
          // exact match or endsWith (to handle extra encoding/prefix differences)
          if (f === base || f === decodeURIComponent(base) || f.endsWith(base) || base.endsWith(f)) {
            results.push(path.join(parent, f));
            // also try meta variant
            results.push(path.join(parent, f + '.meta.json'));
          }
        }
      } catch (e) {
        // ignore read errors
      }
    }
  }

  // uniq results
  const uniq = Array.from(new Set(results.filter(Boolean)));

  let deleted = false;
  for (const p of uniq) {
    if (tryUnlink(p)) {
      deleted = true;
      // attempt remove accompanying meta file if any
      tryUnlink(p + '.meta.json');
      // also try removing encoded variant meta
      try { tryUnlink(p + '.meta.json'); } catch(e){}
      break;
    }
  }

  if (deleted) {
    return res.json({ ok: true });
  } else {
    return res.status(404).json({ error: 'not found', tried: uniq });
  }
});

app.listen(PORT, () => {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  console.log(`Local Worker API emulator running at http://localhost:${PORT}`);
  console.log(`Storage dir: ${STORAGE_DIR}`);
});
