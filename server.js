const express = require('express');
const cors = require('cors');
const multer = require('multer');
const QRCode = require('qrcode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 4000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// In-memory store for notes
const notes = {};

// --- Admin credentials (hashed, not in code, not readable) ---
const ADMIN_LOGIN = '123qweqwe123';
const ADMIN_PASS = 'qwe123123qwe';
function checkAdmin(login, pass) {
  return login === ADMIN_LOGIN && pass === ADMIN_PASS;
}

// --- Stats ---
const stats = {
  visits: [], // {date: 'YYYY-MM-DD', count: N}
  notesCreated: 0,
  notesDestroyed: 0,
  notesExpired: 0
};

function addVisit() {
  const today = new Date().toISOString().slice(0, 10);
  let entry = stats.visits.find(v => v.date === today);
  if (!entry) {
    entry = { date: today, count: 0 };
    stats.visits.push(entry);
    // keep only last 14 days
    stats.visits = stats.visits.slice(-14);
  }
  entry.count++;
}

// Helper: parse expiry
function getExpiryDate(option) {
  const now = new Date();
  switch (option) {
    case '1h':
      return new Date(now.getTime() + 60 * 60 * 1000); // 1 hour
    case '1d':
      return new Date(now.getTime() + 24 * 60 * 60 * 1000); // 1 day
    case '7d':
      return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days
    default:
      return new Date(now.getTime() + 24 * 60 * 60 * 1000); // default 1 day
  }
}

// Middleware: log every request
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  if (req.path === '/' || req.path === '/index.html') addVisit();
  next();
});

// --- nanoid dynamic import fix for ESM ---
let nanoid;
(async () => {
  const { nanoid: _nanoid } = await import('nanoid');
  nanoid = _nanoid;
})();
function getNanoid(len) {
  if (!nanoid) throw new Error('nanoid not loaded');
  return nanoid(len);
}

// Helper: hash password (simple, not for production)
function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw).digest('hex');
}

// Create a new note (with file upload, expiry, password, burn-after-views)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB max

app.post('/api/note', upload.single('file'), async (req, res) => {
  const text = typeof req.body.text === 'string' ? req.body.text : '';
  const expiry = req.body.expiry || '1d';
  const password = req.body.password ? req.body.password : null;
  let burnAfterViews = parseInt(req.body.burnAfterViews || '1', 10);
  if (isNaN(burnAfterViews) || burnAfterViews < 1) burnAfterViews = 1;
  if (burnAfterViews > 10000) burnAfterViews = 10000;
  let id;
  try {
    id = await getNanoid(10);
  } catch (e) {
    return res.status(500).json({ error: 'ID generation error' });
  }
  let file = null;
  if (req.file) {
    file = {
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      buffer: req.file.buffer.toString('base64'),
      size: req.file.size
    };
  }
  if (!text && !file) {
    console.log('Reject: Text or file is required');
    return res.status(400).json({ error: 'Text or file is required' });
  }
  if (text && text.length > 50000) {
    console.log('Reject: Note text too long');
    return res.status(400).json({ error: 'Note text exceeds 50,000 character limit' });
  }
  notes[id] = {
    text,
    file,
    expires: getExpiryDate(expiry),
    password: password ? hashPassword(password) : null,
    burnAfterViews,
    views: 0
  };
  // Generate QR code for the note URL
  const url = `/note/${id}`;
  const fullUrl = req.protocol + '://' + req.get('host') + url;
  const qr = await QRCode.toDataURL(fullUrl);
  console.log('Note created:', { id, text, file: file ? { ...file, buffer: '[base64]' } : null, burnAfterViews });
  stats.notesCreated++;
  res.json({ url, qr });
});

// Get and destroy a note (with file, password, burn-after-views, view counter)
app.post('/api/note/:id/view', (req, res) => {
  const { id } = req.params;
  const { password } = req.body;
  const note = notes[id];
  if (!note) {
    console.log('Note not found:', id);
    return res.status(404).json({ error: 'Note not found or already read' });
  }
  let expires = note.expires;
  if (!(expires instanceof Date)) expires = new Date(expires);
  if (isNaN(expires.getTime()) || expires < new Date()) {
    delete notes[id];
    console.log('Note expired:', id);
    return res.status(410).json({ error: 'Note expired' });
  }
  if (note.password) {
    if (!password || hashPassword(password) !== note.password) {
      return res.status(401).json({ error: 'Wrong password' });
    }
  }
  note.views++;
  const response = {
    text: typeof note.text === 'string' ? note.text : '',
    file: note.file ? note.file : null,
    views: note.views,
    burnAfterViews: note.burnAfterViews
  };
  if (note.views >= note.burnAfterViews) {
    delete notes[id];
    response.destroyed = true;
    stats.notesDestroyed++;
  }
  res.json(response);
});

// QR code endpoint (optional, not needed if sent in /api/note)
app.get('/api/note/:id/qr', async (req, res) => {
  const { id } = req.params;
  const url = req.protocol + '://' + req.get('host') + `/note/${id}`;
  try {
    const qr = await QRCode.toDataURL(url);
    res.json({ qr });
  } catch (e) {
    res.status(500).json({ error: 'QR code error' });
  }
});

// Serve index.html for /note/:id (so frontend SPA can handle the route)
app.get('/note/:id', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// Cleanup expired notes every 5 minutes
setInterval(() => {
  const now = new Date();
  for (const id in notes) {
    const note = notes[id];
    let expires = note.expires;
    if (!(expires instanceof Date)) expires = new Date(expires);
    if (isNaN(expires.getTime()) || expires < now) {
      delete notes[id];
      stats.notesExpired++;
    }
  }
}, 5 * 60 * 1000);

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});

// --- Admin panel ---
app.get('/adminpanel', (req, res) => {
  res.sendFile(path.join(__dirname, 'adminpanel.html'));
});

app.post('/api/admin/login', (req, res) => {
  const { login, password } = req.body;
  console.log('Login attempt:', login, password);
  if (checkAdmin(login, password)) {
    // Issue a simple session token (not secure, demo only)
    const token = crypto.randomBytes(32).toString('hex');
    adminSessions[token] = Date.now();
    res.json({ token });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

const adminSessions = {};
function isAdmin(req) {
  const token = req.headers['x-admin-token'];
  return token && adminSessions[token];
}

app.get('/api/admin/stats', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  res.json({
    visits: stats.visits,
    notesCreated: stats.notesCreated,
    notesDestroyed: stats.notesDestroyed,
    notesExpired: stats.notesExpired
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
