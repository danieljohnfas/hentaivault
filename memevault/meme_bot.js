/* ===================================================
   HotStuff Bot – Automated Meme Scraper v2.0
   100 sources: 50 Reddit subreddits + Giphy + Tenor + Imgur
   Posts 100 unique memes/hour under "HotStuff" account.
   =================================================== */

const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

// ── Config ──────────────────────────────────────────

const BOT_USERNAME = 'HotStuff';
const BOT_PICTURE = 'https://api.dicebear.com/7.x/bottts/svg?seed=HotStuff';
const MEMES_PER_RUN = 200;
const RUN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_PER_SOURCE = 10; // Increased cap for higher volume

// OCR & Language detection
const Tesseract = require('tesseract.js');
const { franc } = require('franc-min');

// ── Reddit Sources (50 subreddits) ──────────────────

const REDDIT_SOURCES = [
    // Swahili & East African
    { subreddit: 'Kenya', category: 'Kiswahili', tags: ['#kenya', '#swahili', '#meme'] },
    { subreddit: 'Nairobi', category: 'Kiswahili', tags: ['#nairobi', '#swahili', '#meme'] },
    { subreddit: 'Tanzania', category: 'Kiswahili', tags: ['#tanzania', '#swahili', '#meme'] },
    { subreddit: 'AfricanMemes', category: 'Kiswahili', tags: ['#africa', '#swahili', '#meme'] },
    { subreddit: 'Uganda', category: 'Kiswahili', tags: ['#uganda', '#swahili', '#meme'] },
    // A few global fallbacks
    { subreddit: 'memes', category: 'Funny', tags: ['#meme', '#global', '#reddit'] },
    { subreddit: 'funny', category: 'Funny', tags: ['#funny', '#lol', '#reddit'] },
];

// ── External API Sources ─────────────────────────────

// Giphy: get key at https://developers.giphy.com
const GIPHY_KEY = process.env.GIPHY_API_KEY || '';
const GIPHY_SEARCHES = [
    { term: 'swahili meme', category: 'Kiswahili', tags: ['#gif', '#swahili', '#giphy'] },
    { term: 'kenya meme', category: 'Kiswahili', tags: ['#gif', '#kenyan', '#giphy'] },
    { term: 'tanzania funny', category: 'Kiswahili', tags: ['#gif', '#tanzanian', '#giphy'] },
    { term: 'bongo meme', category: 'Kiswahili', tags: ['#gif', '#bongo', '#giphy'] },
    { term: 'african meme', category: 'Kiswahili', tags: ['#gif', '#africa', '#giphy'] },
];

// Tenor: get key at https://tenor.com/developer
const TENOR_KEY = process.env.TENOR_API_KEY || '';
const TENOR_SEARCHES = [
    { term: 'swahili', category: 'Kiswahili', tags: ['#gif', '#swahili', '#tenor'] },
    { term: 'kenyan meme', category: 'Kiswahili', tags: ['#gif', '#kenya', '#tenor'] },
    { term: 'tanzania meme', category: 'Kiswahili', tags: ['#gif', '#tanzania', '#tenor'] },
    { term: 'nairobi', category: 'Kiswahili', tags: ['#gif', '#nairobi', '#tenor'] },
];

// Imgur: get key at https://api.imgur.com/oauth2/addclient
const IMGUR_CLIENT_ID = process.env.IMGUR_CLIENT_ID || '';
const IMGUR_SEARCHES = [
    { term: 'swahili funny', category: 'Kiswahili', tags: ['swahili', 'funny', 'imgur'] },
    { term: 'kenya memes', category: 'Kiswahili', tags: ['kenya', 'trending'] },
    { term: 'bongo humor', category: 'Kiswahili', tags: ['tanzania', 'bongo'] },
    { term: 'trending africa', category: 'Kiswahili', tags: ['africa', 'fresh'] },
    { term: 'sheng memes', category: 'Kiswahili', tags: ['sheng', 'nairobi'] }
];

// TikTok (RapidAPI Placeholder)
const RAPIDAPI_KEY_TIKTOK = process.env.RAPIDAPI_KEY_TIKTOK || '';
const TIKTOK_SEARCHES = [
    { term: 'swahili memes', category: 'Kiswahili', tags: ['#tiktok', '#swahili'] },
    { term: 'kenyan memes', category: 'Kiswahili', tags: ['#tiktok', '#kenya'] },
    { term: 'tanzania memes', category: 'Kiswahili', tags: ['#tiktok', '#tanzania'] },
];

// Instagram (RapidAPI Placeholder)
const RAPIDAPI_KEY_INSTAGRAM = process.env.RAPIDAPI_KEY_INSTAGRAM || '';
const INSTAGRAM_SEARCHES = [
    { term: 'swahili memes', category: 'Kiswahili', tags: ['#instagram', '#swahili'] },
    { term: 'bongo memes', category: 'Kiswahili', tags: ['#instagram', '#bongo'] },
];

// Facebook (RapidAPI Placeholder)
const RAPIDAPI_KEY_FACEBOOK = process.env.RAPIDAPI_KEY_FACEBOOK || '';
const FACEBOOK_SEARCHES = [
    { term: 'swahili memes', category: 'Kiswahili', tags: ['#facebook', '#swahili'] },
    { term: 'kenya funny', category: 'Kiswahili', tags: ['#facebook', '#kenya'] },
];

// ── Shared DB reference ──────────────────────────────
let dbQuery, dbRun, isPostgres;

function initBot(deps) {
    dbQuery = deps.dbQuery;
    dbRun = deps.dbRun;
    isPostgres = deps.isPostgres;
}

const TELEGRAM_CHANNELS = [
    { handle: 'kenyan_memes_page', category: 'Kiswahili', tags: ['kenya', 'trending', 'unfiltered'] },
    { handle: 'memesTzonly', category: 'Kiswahili', tags: ['tanzania', 'bongo', 'hot'] },
    { handle: 'bongorahatupu', category: 'Kiswahili', tags: ['tanzania', 'bongo', 'funny'] },
    { handle: 'anti254', category: 'Kiswahili', tags: ['kenya', 'sheng', 'vibe'] },
    { handle: 'funnykenyanvideos', category: 'Kiswahili', tags: ['kenya', 'funny', 'videos'] },
    { handle: 'MemeAfrica', category: 'Kiswahili', tags: ['africa', 'aggregators', 'mixed'] },
    { handle: 'KOTMemeCentral', category: 'Kiswahili', tags: ['kenya', 'twitter', 'kot'] },
    { handle: 'BongoQuotes', category: 'Kiswahili', tags: ['tanzania', 'quotes', 'bongo'] }
];

// ── HTTP Helper ──────────────────────────────────────

const { exec } = require('child_process');

function httpGet(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
        let hCmd = '';
        Object.entries(headers).forEach(([k, v]) => {
            hCmd += ` -H "${k.replace(/"/g, '\\"')}: ${v.toString().replace(/"/g, '\\"')}"`;
        });

        // Use curl.exe for all fetches. It's more robust with TLS/Anti-bot on Windows.
        const command = `curl.exe -s -L -k -A "${ua}" ${hCmd} -i "${url}"`;

        exec(command, { encoding: 'binary', maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) return reject(new Error(`curl failed for ${url}: ${err.message}`));
            
            const buffer = Buffer.from(stdout, 'binary');
            const doubleNewline = buffer.indexOf('\r\n\r\n');
            if (doubleNewline === -1) return reject(new Error(`Malformed response from ${url}`));

            const headStr = buffer.slice(0, doubleNewline).toString();
            const body = buffer.slice(doubleNewline + 4);

            // Simple status/content-type parse
            const statusMatch = headStr.match(/HTTP\/\S+ (\d+)/);
            const status = statusMatch ? parseInt(statusMatch[1]) : 0;
            const ctMatch = headStr.match(/content-type:\s*(\S+)/i);
            const contentType = ctMatch ? ctMatch[1].toLowerCase() : '';

            // Handle multiple-responses from redirects (curl -L appends them)
            if (status >= 300 && status < 400) {
                // Should already be handled by -L but being safe
            }

            if (status !== 200) {
                return reject(new Error(`HTTP ${status} for ${url}`));
            }

            resolve({ body, contentType });
        });
    });
}

// ── Discovery Helpers ────────────────────────────────

async function isSwahili(text) {
    if (!text || text.length < 5) return false;
    const lang = franc(text);
    return lang === 'swa';
}

async function readMemeText(imageBuffer) {
    try {
        const { data: { text } } = await Tesseract.recognize(imageBuffer, 'swa');
        return text;
    } catch (err) {
        console.warn(`[HotStuff] OCR Error: ${err.message}`);
        return null;
    }
}

async function fetchInternetMemes(query) {
    // Universal Google Image Search scraper
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}+meme&tbm=isch`;
    try {
        const { body } = await httpGet(url);
        const html = body.toString();
        
        // Extract raw image URLs from the Google search result
        const urls = [];
        const regex = /"https:\/\/encrypted-tbn0\.gstatic\.com\/images\?q=tbn:([^"]+)"/g;
        let match;
        while ((match = regex.exec(html)) !== null) {
            urls.push(`https://encrypted-tbn0.gstatic.com/images?q=tbn:${match[1]}`);
        }
        
        return urls.slice(0, 15).map(u => ({
            title: `Discovered: ${query}`,
            mediaUrl: u,
            isNsfw: false,
            source: 'Discovery'
        }));
    } catch (err) {
        console.warn(`[HotStuff] Discovery "${query}": ${err.message}`);
        return [];
    }
}

// ── Reddit Fetcher ───────────────────────────────────

async function fetchTelegramMemes(handle) {
    const url = `https://t.me/s/${handle}`;
    try {
        const { body } = await httpGet(url);
        const html = body.toString();
        
        // Extract message blocks (basic regex to get chunks)
        const messages = html.split('<div class="tgme_widget_message_bubble">').slice(1);
        const candidates = [];

        for (const msg of messages) {
            let title = '';
            let mediaUrl = null;
            let isVideo = false;

            // 1. Extract Text/Caption
            const textMatch = msg.match(/<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/);
            if (textMatch) title = textMatch[1].replace(/<[^>]+>/g, '').trim().slice(0, 200);

            // 2. Extract Image (background-image in style)
            const imgMatch = msg.match(/background-image:url\(['"]?([^'"]+)['"]?\)/);
            if (imgMatch) mediaUrl = imgMatch[1];

            // 3. Extract Video (src in video tag)
            const videoMatch = msg.match(/<video[^>]+src=['"]([^'"]+)['"]/);
            if (videoMatch) {
                mediaUrl = videoMatch[1];
                isVideo = true;
            }

            if (mediaUrl) {
                candidates.push({
                    title: title || `Meme from @${handle}`,
                    mediaUrl: mediaUrl,
                    isNsfw: false, // Telegram public previews are generally safe or would be blocked anyway
                    isVideo
                });
            }
        }
        return candidates;
    } catch (err) {
        console.warn(`[HotStuff] Telegram @${handle}: ${err.message}`);
        return [];
    }
}

// ── Deduplication ────────────────────────────────────

async function isSeenUrl(url) {
    const rows = await dbQuery('SELECT url FROM seen_urls WHERE url = ?', [url]);
    return rows.length > 0;
}

async function markUrlSeen(url) {
    try {
        await dbRun('INSERT INTO seen_urls (url) VALUES (?)', [url]);
    } catch (_) { /* already exists */ }
}

// ── HotStuff User ────────────────────────────────────

async function ensureHotStuffUser() {
    const existing = await dbQuery('SELECT id FROM users WHERE username = ?', [BOT_USERNAME]);
    if (existing.length > 0) return;

    const bcrypt = require('bcryptjs');
    const randomPassword = require('crypto').randomBytes(32).toString('hex');
    const hash = await bcrypt.hash(randomPassword, 10);
    await dbRun(
        'INSERT INTO users (username, email, password_hash, picture) VALUES (?, ?, ?, ?)',
        [BOT_USERNAME, 'hotstuff@memevault.internal', hash, BOT_PICTURE]
    );
    console.log('[HotStuff] ✨ Created HotStuff bot account.');
}

// ── Reddit Fetcher ───────────────────────────────────

function extractMediaUrl(post) {
    const d = post.data;
    const imageExts = /\.(jpg|jpeg|png|gif|webp|mp4|webm)(\?.*)?$/i;

    // Prefer original if it's i.redd.it or a non-Imgur direct media link
    if (d.url && d.url.includes('i.redd.it')) return d.url;
    if (d.url && imageExts.test(d.url) && !d.url.includes('v.redd.it') && !d.url.includes('imgur.com')) {
        return d.url.split('?')[0];
    }

    // For Imgur links, always rely on Reddit's cached static preview to avoid API/HTML blocks
    if (d.preview?.images?.[0]?.source?.url) {
        // If it's a video post, try to get the video URL first
        if (d.is_video && d.media?.reddit_video?.fallback_url) {
            return d.media.reddit_video.fallback_url.split('?')[0];
        }
        return d.preview.images[0].source.url.replace(/&amp;/g, '&');
    }

    // Fallback Imgur logic (might result in HTML, which downloadAndStore now rejects)
    if (d.url && d.url.includes('imgur.com') && !d.url.includes('/a/') && !d.url.includes('/gallery/')) {
        const clean = d.url.replace(/\?.*$/, '');
        return imageExts.test(clean) ? clean : clean + '.jpg';
    }

    return null;
}

async function fetchRedditMemes(subreddit) {
    // Alternate between 'hot' and 'new' to get both trending and freshest content
    const sort = Math.random() > 0.5 ? 'new' : 'hot';
    const url = `https://www.reddit.com/r/${subreddit}/${sort}.json?limit=25&raw_json=1`;
    try {
        const { body } = await httpGet(url);
        const json = JSON.parse(body.toString());
        const posts = json?.data?.children || [];

        return posts
            .filter(p => !p.data.is_self && !p.data.removed_by_category && p.data.score >= (sort === 'new' ? 0 : 50))
            .map(p => ({
                title: p.data.title.slice(0, 200),
                mediaUrl: extractMediaUrl(p),
                isNsfw: p.data.over_18 || false,
            }))
            .filter(p => p.mediaUrl);
    } catch (err) {
        console.warn(`[HotStuff] r/${subreddit} (${sort}): ${err.message}`);
        return [];
    }
}

// ── Giphy Fetcher ────────────────────────────────────

async function fetchGiphyMemes(term) {
    if (!GIPHY_KEY) return [];
    const url = `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_KEY}&q=${encodeURIComponent(term)}&limit=10&rating=g`;
    try {
        const { body } = await httpGet(url);
        const json = JSON.parse(body.toString());
        return (json.data || []).map(g => ({
            title: g.title || `${term} GIF`,
            mediaUrl: g.images?.looping?.mp4 || g.images?.original?.mp4 || g.images?.original?.url || null,
            isNsfw: false,
        })).filter(g => g.mediaUrl);
    } catch (err) {
        console.warn(`[HotStuff] Giphy "${term}": ${err.message}`);
        return [];
    }
}

// ── Tenor Fetcher ────────────────────────────────────

async function fetchTenorMemes(term) {
    if (!TENOR_KEY) return [];
    const url = `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(term)}&key=${TENOR_KEY}&limit=10&media_filter=gif`;
    try {
        const { body } = await httpGet(url);
        const json = JSON.parse(body.toString());
        return (json.results || []).map(r => ({
            title: r.content_description || `${term} GIF`,
            mediaUrl: r.media_formats?.gif?.url || r.media_formats?.mediumgif?.url || null,
            isNsfw: false,
        })).filter(g => g.mediaUrl);
    } catch (err) {
        console.warn(`[HotStuff] Tenor "${term}": ${err.message}`);
        return [];
    }
}

// ── Imgur Fetcher ────────────────────────────────────

async function fetchImgurMemes(term) {
    if (!IMGUR_CLIENT_ID) return [];
    const url = `https://api.imgur.com/3/gallery/search/top?q=${encodeURIComponent(term)}&mature=false`;
    try {
        const { body } = await httpGet(url, { 'Authorization': `Client-ID ${IMGUR_CLIENT_ID}` });
        const json = JSON.parse(body.toString());
        const results = [];
        for (const item of (json.data || [])) {
            // Skip albums, only take single images
            if (item.is_album) continue;
            if (!item.link) continue;
            const ext = item.link.split('.').pop().toLowerCase();
            if (!['jpg', 'jpeg', 'png', 'gif', 'mp4', 'webm', 'webp'].includes(ext)) continue;
            results.push({
                title: item.title || `${term} meme`,
                mediaUrl: item.link,
                isNsfw: item.nsfw || false,
            });
        }
        return results;
    } catch (err) {
        console.warn(`[HotStuff] Imgur "${term}": ${err.message}`);
        return [];
    }
}

// ── RapidAPI Fetchers (TikTok/Instagram/Facebook) ────
// These require active RapidAPI subscriptions to function. 
// If keys are provided, they return simulated payloads or make actual API calls.

async function fetchTikTokMemes(term) {
    if (!RAPIDAPI_KEY_TIKTOK) return [];
    const url = `https://tiktok-scraper7.p.rapidapi.com/feed/search?keywords=${encodeURIComponent(term)}`;
    try {
        const { body } = await httpGet(url, {
            'X-RapidAPI-Key': RAPIDAPI_KEY_TIKTOK,
            'X-RapidAPI-Host': 'tiktok-scraper7.p.rapidapi.com'
        });
        const json = JSON.parse(body.toString());
        return (json.data?.videos || []).map(v => ({
            title: v.title || `${term} video`,
            mediaUrl: v.play || v.cover || null,
            isNsfw: false,
        })).filter(v => v.mediaUrl);
    } catch (err) {
        console.warn(`[HotStuff] TikTok RapidAPI "${term}": ${err.message}`);
        return [];
    }
}

async function fetchInstagramMemes(term) {
    if (!RAPIDAPI_KEY_INSTAGRAM) return [];
    const url = `https://instagram-scraper-api2.p.rapidapi.com/v1.2/posts?search_query=${encodeURIComponent(term)}`;
    try {
        const { body } = await httpGet(url, {
            'X-RapidAPI-Key': RAPIDAPI_KEY_INSTAGRAM,
            'X-RapidAPI-Host': 'instagram-scraper-api2.p.rapidapi.com'
        });
        const json = JSON.parse(body.toString());
        return (json.data?.items || []).map(i => ({
            title: i.caption?.text || `${term} post`,
            mediaUrl: i.video_versions?.[0]?.url || i.image_versions2?.candidates?.[0]?.url || null,
            isNsfw: false,
        })).filter(i => i.mediaUrl);
    } catch (err) {
        console.warn(`[HotStuff] Instagram RapidAPI "${term}": ${err.message}`);
        return [];
    }
}

async function fetchFacebookMemes(term) {
    if (!RAPIDAPI_KEY_FACEBOOK) return [];
    const url = `https://facebook-scraper3.p.rapidapi.com/search?query=${encodeURIComponent(term)}`;
    try {
        const { body } = await httpGet(url, {
            'X-RapidAPI-Key': RAPIDAPI_KEY_FACEBOOK,
            'X-RapidAPI-Host': 'facebook-scraper3.p.rapidapi.com'
        });
        const json = JSON.parse(body.toString());
        return (json.results || []).map(r => ({
            title: r.text || `${term} post`,
            mediaUrl: r.media?.[0]?.url || r.image || null,
            isNsfw: false,
        })).filter(r => r.mediaUrl);
    } catch (err) {
        console.warn(`[HotStuff] Facebook RapidAPI "${term}": ${err.message}`);
        return [];
    }
}

// ── File Storage ─────────────────────────────────────

const UPLOADS_DIR = path.join(__dirname, 'uploads');

async function downloadAndStore(mediaUrl) {
    try {
        const { body, contentType } = await httpGet(mediaUrl);
        if (body.length < 1000) return null; // Skip tiny/broken files

        // Block HTML pages masquerading as images (common with Imgur redirects)
        if (contentType && contentType.toLowerCase().includes('text/html')) {
            console.warn(`[HotStuff] Warn: skipped HTML content from ${mediaUrl}`);
            return null;
        }
        if (body.toString('utf8', 0, 50).toLowerCase().includes('<!doctype html')) {
            console.warn(`[HotStuff] Warn: skipped document payload from ${mediaUrl}`);
            return null;
        }

        let ext = '.jpg';
        if (contentType.includes('gif')) ext = '.gif';
        else if (contentType.includes('png')) ext = '.png';
        else if (contentType.includes('webp')) ext = '.webp';
        else if (contentType.includes('mp4') || contentType.includes('video')) ext = '.mp4';
        else if (contentType.includes('webm')) ext = '.webm';
        else {
            const urlExt = mediaUrl.split('.').pop().toLowerCase().split('?')[0];
            if (['gif', 'png', 'webp', 'mp4', 'webm', 'jpg', 'jpeg'].includes(urlExt)) {
                ext = '.' + (urlExt === 'jpeg' ? 'jpg' : urlExt);
            }
        }

        const filename = `hotstuff-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;

        if (process.env.R2_ACCESS_KEY_ID) {
            const { S3Client } = require('@aws-sdk/client-s3');
            const { Upload } = require('@aws-sdk/lib-storage');
            const s3 = new S3Client({
                region: 'auto',
                endpoint: process.env.R2_ENDPOINT,
                credentials: {
                    accessKeyId: process.env.R2_ACCESS_KEY_ID,
                    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
                }
            });
            await new Upload({
                client: s3,
                params: { Bucket: process.env.R2_BUCKET_NAME, Key: filename, Body: body, ContentType: contentType || 'image/jpeg' }
            }).done();
            const pub = process.env.R2_PUBLIC_URL
                ? `${process.env.R2_PUBLIC_URL}/${filename}`
                : `${process.env.R2_ENDPOINT}/${process.env.R2_BUCKET_NAME}/${filename}`;
            return pub;
        } else {
            fs.writeFileSync(path.join(UPLOADS_DIR, filename), body);
            return `/uploads/${filename}`;
        }
    } catch (err) {
        console.warn(`[HotStuff] Download failed: ${err.message}`);
        return null;
    }
}

// ── Post to DB ───────────────────────────────────────

async function postMeme({ title, storedUrl, category, tags, isNsfw }) {
    await dbRun(
        `INSERT INTO posts (title, category, image, author, authorPic, tags, is_nsfw, upvotes, time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            title, category, storedUrl, BOT_USERNAME, BOT_PICTURE,
            JSON.stringify(tags), isNsfw ? 1 : 0,
            Math.floor(Math.random() * 800) + 100, // Realistic upvotes
            'Just now'
        ]
    );
}

// ── Process a Batch of Candidates ───────────────────

async function processCandidates(candidates, meta, posted, quota) {
    let count = 0;
    for (const candidate of candidates) {
        if (count >= quota || posted.value >= MEMES_PER_RUN) break;
        if (!candidate.mediaUrl) continue;
        if (await isSeenUrl(candidate.mediaUrl)) continue;

        // Fetch data once to download and potentially OCR
        const { body: imageBuffer } = await httpGet(candidate.mediaUrl).catch(() => ({ body: null }));
        if (!imageBuffer) continue;

        // Verify if it's Kiswahili (Discovery Mode)
        if (meta.discovery) {
            const ocrText = await readMemeText(imageBuffer);
            const combinedText = `${candidate.title} ${ocrText || ''}`.toLowerCase();
            const confidence = await isSwahili(combinedText);
            
            if (!confidence) {
                // Secondary check: common Swahili keywords if franc fails on short text
                const keywords = ['meme', 'vichekesho', 'kiswahili', 'kenya', 'bongo', 'sheng', 'wakenya', 'watanzania'];
                const hasKeyword = keywords.some(k => combinedText.includes(k));
                if (!hasKeyword) continue; 
            }
        }

        const storedUrl = await downloadAndStore(candidate.mediaUrl);
        if (!storedUrl) continue;

        await markUrlSeen(candidate.mediaUrl);
        await postMeme({ title: candidate.title, storedUrl, ...meta, isNsfw: candidate.isNsfw });

        count++;
        posted.value++;
    }
    return count;
}

// ── Main Bot Runner ──────────────────────────────────

async function runHotStuffBot() {
    console.log('[HotStuff] 🤖 Starting run...');
    const posted = { value: 0 };
    const QUOTA = MAX_PER_SOURCE; // memes per source

    try {
        await ensureHotStuffUser();

        // ── Phase 1: Reddit (50 sources) ──────────────
        const shuffledReddit = [...REDDIT_SOURCES].sort(() => Math.random() - 0.5);
        for (const src of shuffledReddit) {
            if (posted.value >= MEMES_PER_RUN) break;
            const candidates = await fetchRedditMemes(src.subreddit);
            const n = await processCandidates(candidates, { category: src.category, tags: src.tags }, posted, QUOTA);
            if (n > 0) process.stdout.write(`  r/${src.subreddit}: ${n}\n`);
            await new Promise(r => setTimeout(r, 800)); // polite delay
        }

        // ── Phase 2: Giphy ────────────────────────────
        if (GIPHY_KEY) {
            const shuffledGiphy = [...GIPHY_SEARCHES].sort(() => Math.random() - 0.5);
            for (const src of shuffledGiphy) {
                if (posted.value >= MEMES_PER_RUN) break;
                const candidates = await fetchGiphyMemes(src.term);
                const n = await processCandidates(candidates, { category: src.category, tags: src.tags }, posted, QUOTA);
                if (n > 0) process.stdout.write(`  Giphy "${src.term}": ${n}\n`);
                await new Promise(r => setTimeout(r, 500));
            }
        }

        // ── Phase 3: Tenor ────────────────────────────
        if (TENOR_KEY) {
            const shuffledTenor = [...TENOR_SEARCHES].sort(() => Math.random() - 0.5);
            for (const src of shuffledTenor) {
                if (posted.value >= MEMES_PER_RUN) break;
                const candidates = await fetchTenorMemes(src.term);
                const n = await processCandidates(candidates, { category: src.category, tags: src.tags }, posted, QUOTA);
                if (n > 0) process.stdout.write(`  Tenor "${src.term}": ${n}\n`);
                await new Promise(r => setTimeout(r, 500));
            }
        }

        // ── Phase 4: Imgur ────────────────────────────
        if (IMGUR_CLIENT_ID) {
            const shuffledImgur = [...IMGUR_SEARCHES].sort(() => Math.random() - 0.5);
            for (const src of shuffledImgur) {
                if (posted.value >= MEMES_PER_RUN) break;
                const candidates = await fetchImgurMemes(src.term);
                const n = await processCandidates(candidates, { category: src.category, tags: src.tags }, posted, QUOTA);
                if (n > 0) process.stdout.write(`  Imgur "${src.term}": ${n}\n`);
                await new Promise(r => setTimeout(r, 500));
            }
        }

        // ── Phase 5: Telegram (Niche Communities) ───────
        const tgShuffled = [...TELEGRAM_CHANNELS].sort(() => Math.random() - 0.5);
        for (const chan of tgShuffled) {
            if (posted.value >= MEMES_PER_RUN) break;
            const candidates = await fetchTelegramMemes(chan.handle);
            const n = await processCandidates(candidates, { category: chan.category, tags: chan.tags }, posted, QUOTA);
            if (n > 0) process.stdout.write(`  Telegram @${chan.handle}: ${n}\n`);
            await new Promise(r => setTimeout(r, 500));
        }

        // ── Phase 6: TikTok ────────────────────────────
        if (RAPIDAPI_KEY_TIKTOK) {
            const shuffled = [...TIKTOK_SEARCHES].sort(() => Math.random() - 0.5);
            for (const src of shuffled) {
                if (posted.value >= MEMES_PER_RUN) break;
                const candidates = await fetchTikTokMemes(src.term);
                const n = await processCandidates(candidates, { category: src.category, tags: src.tags }, posted, QUOTA);
                if (n > 0) process.stdout.write(`  TikTok "${src.term}": ${n}\n`);
                await new Promise(r => setTimeout(r, 500));
            }
        }

        // ── Phase 6: Instagram ────────────────────────────
        if (RAPIDAPI_KEY_INSTAGRAM) {
            const shuffled = [...INSTAGRAM_SEARCHES].sort(() => Math.random() - 0.5);
            for (const src of shuffled) {
                if (posted.value >= MEMES_PER_RUN) break;
                const candidates = await fetchInstagramMemes(src.term);
                const n = await processCandidates(candidates, { category: src.category, tags: src.tags }, posted, QUOTA);
                if (n > 0) process.stdout.write(`  Instagram "${src.term}": ${n}\n`);
                await new Promise(r => setTimeout(r, 500));
            }
        }

        // ── Phase 7: Facebook ────────────────────────────
        if (RAPIDAPI_KEY_FACEBOOK) {
            const shuffled = [...FACEBOOK_SEARCHES].sort(() => Math.random() - 0.5);
            for (const src of shuffled) {
                if (posted.value >= MEMES_PER_RUN) break;
                const candidates = await fetchFacebookMemes(src.term);
                const n = await processCandidates(candidates, { category: src.category, tags: src.tags }, posted, QUOTA);
                if (n > 0) process.stdout.write(`  Facebook "${src.term}": ${n}\n`);
                await new Promise(r => setTimeout(r, 500));
            }
        }

        // ── Phase 8: Universal Discovery ──────────────
        const discoveryQueries = [
            'swahili memes', 'kenyan memes', 'bongo memes 2024', 
            'michezo ya kuchekesha', 'sheng memes', 'vichekesho vipya'
        ];
        for (const query of discoveryQueries) {
            if (posted.value >= MEMES_PER_RUN) break;
            const candidates = await fetchInternetMemes(query);
            const n = await processCandidates(candidates, { category: 'Kiswahili', tags: ['discovery', query], discovery: true }, posted, 5);
            if (n > 0) process.stdout.write(`  Discovery "${query}": ${n}\n`);
            await new Promise(r => setTimeout(r, 1000));
        }

        console.log(`[HotStuff] ✅ Run complete: ${posted.value}/${MEMES_PER_RUN} memes posted.`);
        if (!GIPHY_KEY) console.log('[HotStuff] 💡 Add GIPHY_API_KEY to .env for more sources.');
        if (!TENOR_KEY) console.log('[HotStuff] 💡 Add TENOR_API_KEY to .env for more sources.');
        if (!IMGUR_CLIENT_ID) console.log('[HotStuff] 💡 Add IMGUR_CLIENT_ID to .env for more sources.');
        if (!RAPIDAPI_KEY_TIKTOK) console.log('[HotStuff] 💡 Add RAPIDAPI_KEY_TIKTOK to .env for TikTok sources.');
        if (!RAPIDAPI_KEY_INSTAGRAM) console.log('[HotStuff] 💡 Add RAPIDAPI_KEY_INSTAGRAM to .env for Instagram sources.');
        if (!RAPIDAPI_KEY_FACEBOOK) console.log('[HotStuff] 💡 Add RAPIDAPI_KEY_FACEBOOK to .env for Facebook sources.');

    } catch (err) {
        console.error('[HotStuff] ❌ Bot run failed:', err.message);
    }
}

// ── Public Entry Point ───────────────────────────────

function startHotStuffBot() {
    const { Pool } = require('pg');
    const sqlite3 = require('sqlite3').verbose();

    let _db, _isPostgres = false;
    if (process.env.DATABASE_URL) {
        _db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
        _isPostgres = true;
    } else {
        _db = new sqlite3.Database(path.join(__dirname, 'database.sqlite'));
    }

    const _dbQuery = (sql, params = []) => {
        if (_isPostgres) {
            let i = 0; const pg = sql.replace(/\?/g, () => `$${++i}`);
            return _db.query(pg, params).then(r => r.rows);
        }
        return new Promise((resolve, reject) => _db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
    };

    const _dbRun = (sql, params = []) => {
        if (_isPostgres) {
            let i = 0; const pg = sql.replace(/\?/g, () => `$${++i}`);
            return _db.query(pg, params);
        }
        return new Promise((resolve, reject) => _db.run(sql, params, function (err) { err ? reject(err) : resolve(this); }));
    };

    initBot({ dbQuery: _dbQuery, dbRun: _dbRun, isPostgres: _isPostgres });

    console.log(`[HotStuff] 🕐 Scheduled: ${MEMES_PER_RUN} memes every 5 minutes from ${REDDIT_SOURCES.length} Reddit + Telegram + Giphy + Tenor + Imgur sources.`);

    // Run immediately, then every hour
    runHotStuffBot();
    setInterval(runHotStuffBot, RUN_INTERVAL_MS);
}

module.exports = { startHotStuffBot };
