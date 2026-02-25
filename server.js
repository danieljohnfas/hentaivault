/* =====================================================
   MemeVault – Local Express Server
   Serves the app on http://localhost:8080
   Handles file uploads to the uploads/ folder
   ===================================================== */

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = 8080;

// ── Database Setup ──────────────────────────────────
const dbFile = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbFile);

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        category TEXT,
        image TEXT,
        author TEXT,
        authorPic TEXT,
        tags TEXT,
        upvotes INTEGER DEFAULT 1,
        comments INTEGER DEFAULT 0,
        time TEXT DEFAULT 'Just now'
    )`);
});

// ── Ensure uploads directory exists ─────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// ── Multer: save files to disk with original extension
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1e6);
        const ext = path.extname(file.originalname);
        cb(null, unique + ext);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB max
    fileFilter: (req, file, cb) => {
        const ok = /^image\/|^video\//.test(file.mimetype);
        cb(ok ? null : new Error('Only images and videos are allowed'), ok);
    }
});

// ── Middleware ───────────────────────────────────────
app.use(cors());
app.use(express.json());

// Serve static files (HTML, CSS, JS, images, uploads)
app.use(express.static(__dirname));
app.use('/uploads', express.static(UPLOADS_DIR));

// ── Endpoints ─────────────────────────────────────────

// Get all posts
app.get('/api/posts', (req, res) => {
    const isLoggedIn = req.query.loggedIn === 'true';
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    db.all('SELECT * FROM posts ORDER BY id DESC LIMIT ? OFFSET ?', [limit, offset], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        let posts = rows.map(r => ({
            ...r,
            tags: JSON.parse(r.tags || '[]'),
            commentList: [],
            userVote: null,
            saved: false
        }));

        // Filter NSFW if not logged in
        if (!isLoggedIn) {
            posts = posts.filter(p => !p.tags.includes('#nsfw') && !p.tags.includes('#NSFW'));
        }

        res.json(posts);
    });
});

// Get community stats
app.get('/api/stats', (req, res) => {
    const stats = { members: 0, laughs: 0, topContributors: [] };

    db.get('SELECT COUNT(DISTINCT author) as count FROM posts', [], (err, row) => {
        if (!err && row) stats.members = row.count || 0;

        db.get('SELECT SUM(upvotes) as total FROM posts', [], (err, row) => {
            if (!err && row) stats.laughs = row.total || 0;

            db.all('SELECT author, authorPic, SUM(upvotes) as pts FROM posts GROUP BY author ORDER BY pts DESC LIMIT 5', [], (err, rows) => {
                if (!err && rows) stats.topContributors = rows;
                res.json(stats);
            });
        });
    });
});

// Create new post
app.post('/api/posts', (req, res) => {
    const { title, category, image, author, authorPic, tags } = req.body;
    db.run(
        `INSERT INTO posts (title, category, image, author, authorPic, tags) VALUES (?, ?, ?, ?, ?, ?)`,
        [title, category, image, author, authorPic, JSON.stringify(tags)],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID });
        }
    );
});

// Upvote post
app.post('/api/posts/:id/upvote', (req, res) => {
    const dir = req.body.dir === 'up' ? 1 : -1;
    db.run('UPDATE posts SET upvotes = upvotes + ? WHERE id = ?', [dir, req.params.id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// ── POST /api/upload ─────────────────────────────────
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file received' });

    res.json({
        filename: req.file.filename,
        url: `/uploads/${req.file.filename}`,
        size: req.file.size,
        mimetype: req.file.mimetype,
    });
});

// ── GET /api/uploads ─────────────────────────────────
// List all uploaded files (useful for debugging)
app.get('/api/uploads', (req, res) => {
    const files = fs.readdirSync(UPLOADS_DIR).map(name => ({
        filename: name,
        url: `/uploads/${name}`,
    }));
    res.json({ files });
});

// ── Error handler ────────────────────────────────────
app.use((err, req, res, next) => {
    console.error(err.message);
    res.status(500).json({ error: err.message });
});

// ── Start ────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🚀 MemeVault server running at http://localhost:${PORT}`);
    console.log(`📂 Uploads saved to: ${UPLOADS_DIR}\n`);
});
