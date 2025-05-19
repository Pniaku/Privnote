const express = require('express');
const cors = require('cors');
const multer = require('multer');

const app = express();
const PORT = 4000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// In-memory store for notes
const notes = {};

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
  next();
});

// Use dynamic import for nanoid (ESM only)
let nanoid;
(async () => {
  const { nanoid: _nanoid } = await import('nanoid');
  nanoid = _nanoid;
})();

function awaitNanoid(len) {
  if (!nanoid) throw new Error('nanoid not loaded');
  return nanoid(len);
}

// Create a new note (with file upload and expiry)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB max

app.post('/api/note', upload.single('file'), async (req, res) => {
  const text = typeof req.body.text === 'string' ? req.body.text : '';
  const expiry = req.body.expiry || '1d';
  let id;
  try {
    id = await awaitNanoid(10);
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
  notes[id] = {
    text,
    file,
    expires: getExpiryDate(expiry)
  };
  console.log('Note created:', { id, text, file: file ? { ...file, buffer: '[base64]' } : null });
  res.json({ url: `/note/${id}` });
});

// Get and destroy a note (with file)
app.get('/api/note/:id', (req, res) => {
  const { id } = req.params;
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
  const response = {
    text: typeof note.text === 'string' ? note.text : '',
    file: note.file ? note.file : null
  };
  delete notes[id];
  console.log('Note returned:', { id, response });
  res.json(response);
});

// Fallback: serve index.html for /note/:id so frontend can handle routing
app.get('/note/:id', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
