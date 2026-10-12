const express = require('express');
const https = require('https');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const { S3Client } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { OpenAI } = require('openai');

const app = express();

const createRateLimiter = (windowMs, max, message) => {
    const hits = new Map();
    setInterval(() => hits.clear(), 5 * 60 * 1000);
    return (req, res, next) => {
        const ip = req.ip || req.socket.remoteAddress || 'unknown';
        const now = Date.now();
        const record = hits.get(ip) || { count: 0, resetTime: now + windowMs };
        if (now > record.resetTime) { record.count = 0; record.resetTime = now + windowMs; }
        record.count++;
        hits.set(ip, record);
        if (record.count > max) return res.status(429).json({ error: message });
        next();
    };
};
const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'memevault-secret-key-123';

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// ── Database Setup ──────────────────────────────────
let db;
let isPostgres = false;

if (process.env.DATABASE_URL) {
    db = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
    isPostgres = true;
    console.log('MemeVault v2.0: Connected to PostgreSQL');
} else {
    const dbPath = path.join(__dirname, 'database.sqlite');
    db = new sqlite3.Database(dbPath);
    console.log('MemeVault v2.0: Connected to local SQLite');
}

// DB Helpers
const dbQuery = (sql, params = []) => {
    if (isPostgres) {
        let i = 0;
        const postgresSql = sql.replace(/\?/g, () => `$${++i}`);
        return db.query(postgresSql, params).then(res => res.rows);
    } else {
        return new Promise((resolve, reject) => {
            db.all(sql, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }
};

const dbRun = (sql, params = []) => {
    if (isPostgres) {
        let i = 0;
        const postgresSql = sql.replace(/\?/g, () => `$${++i}`);
        return db.query(postgresSql, params);
    } else {
        return new Promise((resolve, reject) => {
            db.run(sql, params, function (err) {
                if (err) reject(err);
                else resolve(this);
            });
        });
    }
};

const initSchema = async () => {
    try {
        const primaryKey = isPostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';

        // Posts table
        await dbRun(`
            CREATE TABLE IF NOT EXISTS posts (
                id ${primaryKey},
                title TEXT,
                category TEXT,
                image TEXT,
                author TEXT,
                authorPic TEXT,
                tags TEXT,
                upvotes INTEGER DEFAULT 1,
                comments INTEGER DEFAULT 0,
                is_nsfw BOOLEAN DEFAULT 0,
                time TEXT DEFAULT 'Just now'
            )
        `);

        // Migration: ensure is_nsfw column exists if table was already created
        try {
            if (isPostgres) {
                await dbRun('ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_nsfw BOOLEAN DEFAULT FALSE');
            } else {
                await dbRun('ALTER TABLE posts ADD COLUMN is_nsfw BOOLEAN DEFAULT 0');
            }
        } catch (e) { /* ignore if already exists */ }

        // Users table
        await dbRun(`
            CREATE TABLE IF NOT EXISTS users (
                id ${primaryKey},
                username TEXT UNIQUE NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                picture TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Saves Junction Table
        await dbRun(`
            CREATE TABLE IF NOT EXISTS saves (
                user_id INTEGER NOT NULL,
                post_id INTEGER NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, post_id)
            )
        `);
        // Votes Junction Table
        await dbRun(`
            CREATE TABLE IF NOT EXISTS post_votes (
                user_id INTEGER NOT NULL,
                post_id INTEGER NOT NULL,
                dir TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, post_id)
            )
        `);
        // Seen URLs table (for HotStuff bot deduplication)
        await dbRun(`
            CREATE TABLE IF NOT EXISTS seen_urls (
                url TEXT PRIMARY KEY,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        // Global Chat Table
        await dbRun(`
            CREATE TABLE IF NOT EXISTS messages (
                id ${primaryKey},
                user_id INTEGER,
                username TEXT,
                user_picture TEXT,
                text TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        console.log('Database schema verified.');
    } catch (err) {
        console.error('Schema initialization failed:', err);
    }
};
initSchema().then(() => {
    // Start HotStuff bot after schema is ready
    const { startHotStuffBot } = require('./meme_bot');
    startHotStuffBot();
});

// ── Authentication Middleware ───────────────────────
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ error: 'Access denied. No token provided.' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid or expired token.' });
        req.user = user;
        next();
    });
};

const optionalAuthenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return next();
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (!err) req.user = user;
        next();
    });
};

// ── Cloudflare R2 / S3 Setup ────────────────────────
const r2Enabled = !!process.env.R2_ACCESS_KEY_ID;
let s3Client;
if (r2Enabled) {
    s3Client = new S3Client({
        region: 'auto',
        endpoint: process.env.R2_ENDPOINT,
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
    });
}

// ── Multer Configuration ────────────────────────────
const storage = multer.memoryStorage();
const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        const ok = /^image\/|^video\//.test(file.mimetype);
        cb(ok ? null : new Error('Only images and videos are allowed'), ok);
    }
});

// ── Middleware ──────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

const apiLimiter = createRateLimiter(60 * 1000, 200, 'Too many requests, please try again later.');
const authLimiter = createRateLimiter(15 * 60 * 1000, 20, 'Too many authentication attempts.');
const aiLimiter = createRateLimiter(60 * 1000, 10, 'Too many AI generation attempts.');

app.use('/api/', apiLimiter);
app.use('/api/auth/', authLimiter);
app.use('/api/ai/', aiLimiter);

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
app.use('/uploads', express.static(UPLOADS_DIR));

// ── Auth Endpoints ──────────────────────────────────
app.post('/api/auth/signup', async (req, res) => {
    const { username, email, password, picture } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'Missing fields' });

    try {
        const hash = await bcrypt.hash(password, 10);
        await dbRun(
            'INSERT INTO users (username, email, password_hash, picture) VALUES (?, ?, ?, ?)',
            [username, email, hash, picture || '']
        );
        res.status(201).json({ success: true });
    } catch (err) {
        // Handle duplicate key for both PostgreSQL (23505) and SQLite (SQLITE_CONSTRAINT)
        if (err.code === '23505' || err.code === 'SQLITE_CONSTRAINT') {
            return res.status(400).json({ error: 'Username or email already exists' });
        }
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const rows = await dbQuery('SELECT * FROM users WHERE username = ?', [username]);
        const user = rows[0];

        if (!user || !(await bcrypt.compare(password, user.password_hash))) {
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
        res.json({
            token,
            user: { username: user.username, email: user.email, picture: user.picture }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/google', async (req, res) => {
    const { username, email, picture } = req.body;
    console.log('Google auth attempt:', { username, email });
    if (!email) return res.status(400).json({ error: 'Email is required' });

    try {
        let user;
        const rows = await dbQuery('SELECT * FROM users WHERE email = ?', [email]);
        user = rows[0];

        if (!user) {
            console.log('Creating new user for Google login:', email);

            // ── HANDLE USERNAME COLLISION ──
            let finalUsername = username || email.split('@')[0];
            let isUnique = false;
            let attempts = 0;

            while (!isUnique && attempts < 5) {
                const existing = await dbQuery('SELECT id FROM users WHERE username = ?', [finalUsername]);
                if (existing.length === 0) {
                    isUnique = true;
                } else {
                    attempts++;
                    // Append random hex string if collision occurs
                    const suffix = Math.random().toString(16).slice(2, 6);
                    finalUsername = `${username || email.split('@')[0]}_${suffix}`;
                }
            }

            const dummyPassword = Math.random().toString(36).slice(-10);
            const hash = await bcrypt.hash(dummyPassword, 10);

            await dbRun(
                'INSERT INTO users (username, email, password_hash, picture) VALUES (?, ?, ?, ?)',
                [finalUsername, email, hash, picture || '']
            );

            const newRows = await dbQuery('SELECT * FROM users WHERE email = ?', [email]);
            user = newRows[0];
            console.log('New user created with unique username:', user.username);
        } else {
            console.log('Existing Google user found:', user.id);
        }

        if (!user || !user.id) {
            console.error('User object missing ID after find/create:', user);
            return res.status(500).json({ error: 'Failed to retrieve user ID', debug: user });
        }

        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
        console.log('JWT signed for user ID:', user.id);
        res.json({
            token,
            user: { username: user.username, email: user.email, picture: user.picture }
        });
    } catch (err) {
        console.error('Google auth error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ── Posts Endpoints ─────────────────────────────────
app.get('/api/posts', optionalAuthenticateToken, async (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const userId = req.user?.id;

    try {
        let sql;
        let params;

        if (userId) {
            // Join with saves table to see if current user has saved this post
            sql = `
                SELECT p.*, 
                       (s.user_id IS NOT NULL) as saved,
                       v.dir as "userVote"
                FROM posts p
                LEFT JOIN saves s ON p.id = s.post_id AND s.user_id = ?
                LEFT JOIN post_votes v ON p.id = v.post_id AND v.user_id = ?
                ORDER BY p.id DESC LIMIT ? OFFSET ?
            `;
            params = [userId, userId, limit, offset];
        } else {
            // Use 0 as saved (compatible with both SQLite and PostgreSQL)
            const nsfwCondition = isPostgres ? 'is_nsfw = FALSE OR is_nsfw IS NULL' : 'is_nsfw = 0 OR is_nsfw IS NULL';
            sql = `SELECT *, 0 as saved, NULL as "userVote" FROM posts WHERE ${nsfwCondition} ORDER BY id DESC LIMIT ? OFFSET ?`;
            params = [limit, offset];
        }

        const rows = await dbQuery(sql, params);

        let posts = rows.map(r => ({
            ...r,
            authorPic: r.authorPic || r.author_pic || '',
            tags: JSON.parse(r.tags || '[]'),
            commentList: [],
            userVote: r.userVote || null,
            saved: !!r.saved,
            is_nsfw: !!r.is_nsfw
        }));

        // Filter NSFW for unauthenticated users or those who have it off (simple check for now)
        if (!userId) {
            posts = posts.filter(p => !p.is_nsfw && !p.tags.includes('#nsfw'));
        }
        res.json(posts);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/posts/:id/save', authenticateToken, async (req, res) => {
    const postId = req.params.id;
    const userId = req.user.id;

    try {
        // Toggle save
        const existing = await dbQuery('SELECT * FROM saves WHERE user_id = ? AND post_id = ?', [userId, postId]);
        if (existing.length > 0) {
            await dbRun('DELETE FROM saves WHERE user_id = ? AND post_id = ?', [userId, postId]);
            res.json({ saved: false });
        } else {
            await dbRun('INSERT INTO saves (user_id, post_id) VALUES (?, ?)', [userId, postId]);
            res.json({ saved: true });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/stats', async (req, res) => {
    try {
        const stats = { members: 0, laughs: 0, topContributors: [] };

        const memberRows = await dbQuery('SELECT COUNT(DISTINCT author) as count FROM posts');
        stats.members = parseInt(memberRows[0]?.count || 0);

        const laughRows = await dbQuery('SELECT SUM(upvotes) as total FROM posts');
        stats.laughs = parseInt(laughRows[0]?.total || 0);

        stats.topContributors = await dbQuery(
            'SELECT author, author_pic as "authorPic", SUM(upvotes) as pts FROM posts GROUP BY author, author_pic ORDER BY pts DESC LIMIT 5'
        );
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/posts', authenticateToken, async (req, res) => {
    const { title, category, image, author, authorPic, tags } = req.body;
    const isNsfw = tags && (tags.includes('#nsfw') || tags.includes('#NSFW'));
    const sql = `INSERT INTO posts (title, category, image, author, authorPic, tags, is_nsfw) VALUES (?, ?, ?, ?, ?, ?, ?)`;

    try {
        await dbRun(sql, [title, category, image, author, authorPic, JSON.stringify(tags || []), isNsfw]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/posts/:id/upvote', authenticateToken, async (req, res) => {
    const dir = req.body.dir; // 'up', 'down', or null
    const postId = req.params.id;
    const userId = req.user.id;
    
    try {
        const existingVote = await dbQuery('SELECT dir FROM post_votes WHERE user_id = ? AND post_id = ?', [userId, postId]);
        
        if (existingVote.length > 0) {
            const currentDir = existingVote[0].dir;
            if (!dir || dir === currentDir) {
                // Remove vote
                const change = currentDir === 'up' ? -1 : 1;
                await dbRun('DELETE FROM post_votes WHERE user_id = ? AND post_id = ?', [userId, postId]);
                await dbRun('UPDATE posts SET upvotes = upvotes + ? WHERE id = ?', [change, postId]);
                return res.json({ success: true, dir: null });
            } else {
                // Change vote direction
                const change = dir === 'up' ? 2 : -2;
                await dbRun('UPDATE post_votes SET dir = ? WHERE user_id = ? AND post_id = ?', [dir, userId, postId]);
                await dbRun('UPDATE posts SET upvotes = upvotes + ? WHERE id = ?', [change, postId]);
                return res.json({ success: true, dir: dir });
            }
        } else {
            if (!dir) return res.json({ success: true, dir: null });
            // New vote
            const change = dir === 'up' ? 1 : -1;
            await dbRun('INSERT INTO post_votes (user_id, post_id, dir) VALUES (?, ?, ?)', [userId, postId, dir]);
            await dbRun('UPDATE posts SET upvotes = upvotes + ? WHERE id = ?', [change, postId]);
            return res.json({ success: true, dir: dir });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/upload', authenticateToken, upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file received' });

    try {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        const filename = uniqueSuffix + path.extname(req.file.originalname);

        if (r2Enabled) {
            const parallelUploads3 = new Upload({
                client: s3Client,
                params: {
                    Bucket: process.env.R2_BUCKET_NAME,
                    Key: filename,
                    Body: req.file.buffer,
                    ContentType: req.file.mimetype,
                },
            });
            await parallelUploads3.done();

            const publicUrl = process.env.R2_PUBLIC_URL
                ? `${process.env.R2_PUBLIC_URL}/${filename}`
                : `${process.env.R2_ENDPOINT}/${process.env.R2_BUCKET_NAME}/${filename}`;

            res.json({ filename, url: publicUrl });
        } else {
            const filepath = path.join(UPLOADS_DIR, filename);
            fs.writeFileSync(filepath, req.file.buffer);
            res.json({ filename, url: `/uploads/${filename}` });
        }
    } catch (err) {
        res.status(500).json({ error: 'Upload failed: ' + err.message });
    }
});

// ── Chat Endpoints ──────────────────────────────────
app.get('/api/chat', async (req, res) => {
    try {
        const rows = await dbQuery('SELECT * FROM messages ORDER BY id DESC LIMIT 50');
        res.json(rows.reverse());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/stats', async (req, res) => {
    try {
        // Real counts for members and posts (laughs)
        const userCount = await dbQuery('SELECT COUNT(*) as count FROM users');
        const postCount = await dbQuery('SELECT COUNT(*) as count FROM posts');

        // Mock some contributors since we don't have a karma system yet
        const contributors = await dbQuery('SELECT username, picture FROM users LIMIT 10');
        const topContributors = contributors.map(u => ({
            name: u.username,
            avatar: u.picture || ''
        }));

        res.json({
            members: userCount[0].count,
            laughs: postCount[0].count,
            topContributors: topContributors.length > 0 ? topContributors : [{ name: 'System Bot', avatar: '' }]
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/chat', authenticateToken, async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Message text is required' });

    try {
        console.log('Chat attempt from user:', req.user);
        const userRows = await dbQuery('SELECT * FROM users WHERE id = ?', [req.user.id]);
        const user = userRows[0];

        if (!user) {
            console.warn('Chat failure: User ID not found in database:', req.user.id);
            return res.status(404).json({
                error: `User not found (ID: ${req.user.id}). Please try logging out and back in.`,
                debug: { userId: req.user.id }
            });
        }

        await dbRun(
            'INSERT INTO messages (user_id, username, user_picture, text) VALUES (?, ?, ?, ?)',
            [req.user.id, user.username, user.picture || '', text]
        );
        res.status(201).json({ success: true });
    } catch (err) {
        console.error('Chat endpoint error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ── AI Generation Endpoints ─────────────────────────
app.post('/api/ai/generate', authenticateToken, async (req, res) => {
    const { prompt, type, image } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    try {
        const seed = Math.floor(Math.random() * 1000000);
        let aiUrl = '';

        if (type === 'video') {
            console.log('AI Video generation requested (EXPERIMENTAL):', prompt);
            // Pollinations doesn't have a direct raw video model URL easily usable in Image tags.
            // We'll use a 'motion' prompt for flux which sometimes gives very dynamic images,
            // or just tell the user it's a work in progress.
            const motionPrompt = `${prompt}, cinematic motion, dynamic action, gif style`;
            const encoded = encodeURIComponent(motionPrompt);
            aiUrl = `https://image.pollinations.ai/prompt/${encoded}?nologo=true&seed=${seed}&width=1024&height=1024&model=flux`;
        } else {
            // IMAGE TO IMAGE / REMIX LOGIC (BETA)
            if (image) {
                console.log('AI Remix requested for prompt:', prompt);
                const remixPrompt = `Remix and transform this image based on: ${prompt}. Cinematic, high detail, masterpiece.`;
                const encoded = encodeURIComponent(remixPrompt);
                aiUrl = `https://image.pollinations.ai/prompt/${encoded}?nologo=true&seed=${seed}&width=1024&height=1024&model=flux`;
            } else {
                const encodedByPrompt = encodeURIComponent(prompt);
                aiUrl = `https://image.pollinations.ai/prompt/${encodedByPrompt}?nologo=true&seed=${seed}&width=1024&height=1024&model=flux`;
            }
        }

        console.log(`AI Gen SUCCESS: [${type}] Prompt: ${prompt.substring(0, 30)}... -> URL: ${aiUrl}`);
        res.json({ url: aiUrl });
    } catch (err) {
        console.error('AI Gen FAIL:', err);
        res.status(500).json({ error: 'AI Generation failed: ' + err.message });
    }
});

app.post('/api/ai/copilot', authenticateToken, async (req, res) => {
    const { scenario } = req.body;
    if (!scenario) return res.status(400).json({ error: 'Scenario is required' });

    try {
        let imagePrompt = "A funny meme template, expressive face, dramatic background";
        let topText = "WHEN YOU FORGET";
        let bottomText = "TO ADD THE API KEY";

        if (openai) {
            const response = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: "You are a witty meme creator. Return a JSON object with 'imagePrompt' (visual description of the meme background without text), 'topText' (impact font text for the top), and 'bottomText' (impact font text for the bottom). Keep the text punchy and relevant to modern internet culture." },
                    { role: "user", content: `Create a meme for this scenario: ${scenario}` }
                ],
                response_format: { type: "json_object" }
            });
            const result = JSON.parse(response.choices[0].message.content);
            imagePrompt = result.imagePrompt;
            topText = result.topText || "";
            bottomText = result.bottomText || "";
        }

        const seed = Math.floor(Math.random() * 1000000);
        const encodedByPrompt = encodeURIComponent(imagePrompt + ", cinematic, high detail, masterpiece, meme template");
        const aiUrl = `https://image.pollinations.ai/prompt/${encodedByPrompt}?nologo=true&seed=${seed}&width=1024&height=1024&model=flux`;

        console.log(`AI Co-Pilot SUCCESS: Scenario: ${scenario.substring(0, 30)}... -> URL: ${aiUrl}`);
        res.json({ imageUrl: aiUrl, topText: topText.toUpperCase(), bottomText: bottomText.toUpperCase() });
    } catch (err) {
        console.error('AI Co-Pilot FAIL:', err);
        res.status(500).json({ error: 'AI Co-Pilot failed: ' + err.message });
    }
});

app.post('/api/ai/roast', authenticateToken, async (req, res) => {
    const { title, tags } = req.body;
    
    try {
        let roastText = "";
        if (openai) {
            const response = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: "You are a witty, sarcastic internet troll that roasts memes. Keep it to 1 short sentence. Be genuinely funny and slightly brutal." },
                    { role: "user", content: `Roast this meme titled: "${title}" with tags: ${(tags || []).join(', ')}` }
                ]
            });
            roastText = response.choices[0].message.content;
        } else {
            // Fallbacks
            const fallbacks = [
                "This meme is so dry it makes the Sahara look like an ocean.",
                "Did you make this in MS Paint, or are you just naturally this bad at memes?",
                "Not even my grandma would forward this on Facebook.",
                "I've seen better jokes on a popsicle stick.",
                "This post right here, officer."
            ];
            roastText = fallbacks[Math.floor(Math.random() * fallbacks.length)];
        }
        
        res.json({ text: roastText });
    } catch (err) {
        console.error('AI Roast FAIL:', err);
        res.status(500).json({ error: 'AI Roast failed' });
    }
});

app.get('/api/ai/proxy', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send('URL is required');

    try {
        const parsedUrl = new URL(url);
        const allowedDomains = [
            'i.redd.it', 'v.redd.it', 'preview.redd.it', 'reddit.com', 'www.reddit.com',
            'i.imgur.com', 'imgur.com', 'media.giphy.com', 'giphy.com', 'media.tenor.com', 'tenor.com',
            'pollinations.ai', 'image.pollinations.ai', 'tiktok.com', 'tiktok-scraper7.p.rapidapi.com',
            'facebook.com', 'instagram.com', 'api.dicebear.com'
        ];
        
        const isAllowed = allowedDomains.some(d => parsedUrl.hostname === d || parsedUrl.hostname.endsWith('.' + d));
        if (!isAllowed) {
            console.log('Blocked proxy attempt to:', url);
            return res.status(403).send('Forbidden: Domain not allowed for proxying');
        }

        https.get(url, (response) => {
            // Check if it's an image
            const contentType = response.headers['content-type'];
            if (!contentType || !contentType.startsWith('image/')) {
                // Some providers might return diverse types, but we mainly care about images for canvas
            }

            res.setHeader('Content-Type', contentType || 'image/jpeg');
            // Resolve CORS for the browser to allow canvas ingestion
            res.setHeader('Access-Control-Allow-Origin', '*');
            response.pipe(res);
        }).on('error', (err) => {
            console.error('AI Proxy request error:', err);
            res.status(500).send('AI Proxy failed');
        });
    } catch (err) {
        res.status(500).send(err.message);
    }
});

app.use((err, req, res, next) => {
    res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
    console.log(`\n🚀 MemeVault v2.0 running at http://localhost:${PORT}\n`);
});
