#!/usr/bin/env node

/**
 * HentaiVault Advanced Scout V3
 * 
 * Features:
 * 1. Web Spidering (Crawls existing DB for outbound links)
 * 2. Reddit / Social Mining (Expanded Subreddits)
 * 3. Directory Scraping
 * 4. Deep Social Extraction (Discord/Twitter from HTML)
 * 5. Wayback Machine Trust Scoring
 *
 * Every link is reduced to its site's homepage and de-duplicated per site (language
 * subdomains such as de.example.com count as example.com) against the directory and
 * the whole queue. Candidates must look on-topic (adult/hentai/anime) before they
 * are scored. Validation runs in parallel, up to MAX_CANDIDATES per run.
 */

const fs = require('fs');
const path = require('path');
const { scoreSite } = require('./score-site');
const { isMinorSafe } = require('../src/prohibited.js');
const { hostKey, siteKey, brandKey, toHomepage, isTopical, siteName, pool, cleanName, specificCategory } = require('./lib/discovery.js');

const SPIDER_TARGETS = 150;      // existing listings crawled for outbound links per run
const MAX_CANDIDATES = 3000;     // new homepages validated per run
const VALIDATE_CONCURRENCY = 12;
const RUN_BUDGET_MS = 45 * 60 * 1000;


const QUEUE_FILE = path.resolve(__dirname, 'sites-queue.json');

// Subreddits to mine for new URLs — hentai & anime focused only
const SUBREDDITS = [
  'animepiracy',       // main anime/hentai piracy hub
  'hentai',            // hentai content & site recommendations
  'doujinshi',         // doujin & manga community
  'HentaiGames',       // hentai & eroge games
  'animedubs',         // anime streaming/dub discussions
  'manga',             // manga readers
  'visualnovels',      // visual novel & eroge community
  'animesuggest'       // anime recommendations, surfaces streaming sites
];
// Directories to scrape
const DIRECTORIES = [
  'https://everythingmoe.com/',
  'https://theindex.moe/',
  'https://www.hentairules.net/index2.html'
];
const BLACKLIST = ['scam', 'phishing', 'casino', 'betting', 'crypto'];

// Domains that produce junk entries — blocked at scout stage
const DOMAIN_BLACKLIST = [
  // Non-adult platforms
  'eneba.com', 'steampowered.com', 'scribd.com', 'animeonegai.com',
  'securities.dmm.com', 'zerotolerance.com',
  // Document / PDF hosts
  'docs.google.com', 'drive.google.com', 'dropbox.com', 'mega.nz',
  // News, blogs, non-site content
  'medium.com', 'substack.com', 'wordpress.com', 'blogspot.com',
  // Social / app stores
  'apps.apple.com', 'play.google.com', 'chrome.google.com',
  // Tracking / redirect links that are not real sites
  'zline0.com',
  // Game distribution platforms — individual game pages are not directory sites
  'itch.io',
  // Ad networks and brokers
  'adultadbroker.com',
];

// Maximum number of entries from the same base domain allowed in the queue at once.
// Prevents Scout from flooding the queue with many pages from a single site.
const MAX_ENTRIES_PER_DOMAIN = 2;

// URL path patterns that indicate an individual content page, not a site homepage
const JUNK_PATH_PATTERNS = [
  /\.pdf($|\?)/i,
  /\/videos?\//i,
  /\/bucetas?\//i,
  /\/document\//i,
  /\/curator\//i,
  /\/news\//i,
  /\/policy\//i,
  /anti.?trafficking/i,
  /\/hub\/news/i,
  /\/performance\/?$/i,
  /itch\.io\/[^/]+\//i,   // itch.io individual game subpages
];

// Accepts "/", "/en", "/en/", "/home" and "/index.html"; anything deeper is a sub-page.
function isHomepagePath(u) {
  if (u.search) return false;
  const segments = u.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return true;
  return segments.length === 1 && /^([a-z]{2}(-[a-z]{2})?|home|index\.(html?|php))$/i.test(segments[0]);
}

function isJunkUrl(url) {
  try {
    const u = new URL(url);
    const domain = u.hostname.toLowerCase().replace(/^www\./, '');
    // Block blacklisted domains
    if (DOMAIN_BLACKLIST.some(d => domain === d || domain.endsWith('.' + d))) return true;
    // Block junk path patterns
    if (JUNK_PATH_PATTERNS.some(p => p.test(url))) return true;
    // Minor safety: never queue anything blocked or needing manual review.
    if (!isMinorSafe(url)) return true;
    // Only site homepages: performer, category, search and article pages are not "sites".
    if (!isHomepagePath(u)) return true;
    return false;
  } catch {
    return true;
  }
}

// --- Helper Functions ---
function getExistingUrls() {
  const urls = new Set();
  
  // 1. From Queue File
  if (fs.existsSync(QUEUE_FILE)) {
    const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    queue.forEach(s => urls.add(String(s.url).toLowerCase().replace(/\/$/, '')));
  }
  
  // 2. From D1 Export File (via arg)
  const existingFlag = process.argv.findIndex(a => a === '--existing-urls');
  const existingFile = existingFlag !== -1 ? process.argv[existingFlag + 1] : null;
  if (existingFile && fs.existsSync(existingFile)) {
    const raw = JSON.parse(fs.readFileSync(existingFile, 'utf8'));
    raw.forEach(u => {
      const urlStr = typeof u === 'string' ? u : u.url;
      if (urlStr) urls.add(String(urlStr).toLowerCase().replace(/\/$/, ''));
    });
  }
  
  return urls;
}

function isValidUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const domain = u.hostname.toLowerCase();
    // Exclude common non-directory targets
    if (['youtube.com', 'reddit.com', 'twitter.com', 'x.com', 'google.com', 'github.com', 'imgur.com', 'discord.gg', 'discord.com', 'bsky.app', 'airvpn.org', 'wikipedia.org'].some(d => domain.includes(d))) return false;
    if (BLACKLIST.some(b => url.toLowerCase().includes(b))) return false;
    return true;
  } catch {
    return false;
  }
}

// --- 1. Web Spidering ---
async function discoverFromSpidering(existingUrlSet) {
  const discovered = [];
  console.log('🕸️ Spidering existing database links to find related networks...');

  const allExisting = Array.from(existingUrlSet).filter(u => u.startsWith('http'));
  if (allExisting.length === 0) return discovered;

  const targets = allExisting.sort(() => 0.5 - Math.random()).slice(0, SPIDER_TARGETS);
  await pool(targets, 20, async t => {
    try {
      const res = await fetch(t, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return;
      const html = await res.text();
      const links = (html.match(/href="https?:\/\/[^"]+"/g) || [])
        .map(u => u.slice(6, -1))
        .filter(isValidUrl);
      for (const u of links) discovered.push({ url: u, source: 'spider' });
      console.log(`   - Spidered ${t} -> found ${links.length} outbound valid links`);
    } catch {
      // Silently ignore timeout or network errors on crawled sites
    }
  });
  return discovered;
}

// --- 2. Reddit Mining (Subreddits & Global Search) ---
const REDDIT_QUERIES_POOL = [
  // ── Hentai Streaming & Watching ────────────────────────────────────────────
  'watch hentai online', 'best hentai streaming site', 'hentai site recommendation',
  'uncensored hentai stream', 'hentai subbed site', 'hentai dubbed online',
  'free hentai streaming', 'hentai OVA online', 'hentai series watch',
  'hentai tube site', 'hentai video site', 'best hentai site 2024', 'best hentai site 2025',

  // ── Anime Streaming ────────────────────────────────────────────────────────
  'best anime streaming site', 'free anime streaming', 'watch anime online free',
  'crunchyroll alternative', 'funimation alternative', 'anime site recommendation',
  'legal anime streaming', 'anime streaming with subtitles', 'new anime site',
  'watch ecchi anime online', 'ecchi anime streaming site', 'anime piracy site',
  'fansub site', 'anime streaming alternative reddit',

  // ── Manga & Doujinshi ──────────────────────────────────────────────────────
  'read hentai manga online', 'doujinshi site recommendation', 'hentai manga english',
  'best doujin reader', 'nhentai alternative', 'fakku alternative',
  'read doujin free', 'hentai manga download', 'doujinshi download site',
  'best manga reader site', 'read manga online free', 'manga site recommendation',
  'manga reader alternative', 'free webtoon reader', 'hentai comic site',
  'comiket online', 'japanese adult comics english',

  // ── Hentai & Eroge Games ───────────────────────────────────────────────────
  'hentai game site', 'eroge download site', 'visual novel hentai',
  'best hentai games site', 'nutaku alternative', 'f95zone alternative',
  'hentai visual novel download', 'eroge site recommendation',
  'anime adult game', 'hentai RPG site', 'hentai game review site',
  'hentai doujin game download', 'ren\'py adult game site',

  // ── Image Boards & Art ─────────────────────────────────────────────────────
  'hentai booru site', 'rule34 anime site', 'gelbooru alternative',
  'danbooru alternative', 'pixiv alternative', 'hentai image board',
  'hentai gallery site', 'anime fanart booru', 'hentai artist site',
  'nsfw anime art site', 'hentai wallpaper site', 'konachan alternative',

  // ── JAV (anime-adjacent) ───────────────────────────────────────────────────
  'jav streaming site', 'best jav site', 'jav site recommendation',

  // ── Downloads & Torrents ───────────────────────────────────────────────────
  'hentai torrent site', 'anime torrent site', 'nyaa alternative',
  'hentai download site', 'anime download site', 'doujin torrent',
  'anime archive site', 'hentai archive download',

  // ── Communities & Databases ────────────────────────────────────────────────
  'anime database site', 'myanimelist alternative', 'anilist alternative',
  'hentai review site', 'hentai directory', 'anime community site',
  'anime forum recommendation', 'anime news site',

  // ── VR & Interactive Hentai ────────────────────────────────────────────────
  'vr hentai site', 'interactive hentai site', '3d hentai site',
];

async function discoverFromReddit() {
  const discovered = [];
  console.log('🕵️ Mining Reddit for new URLs...');
  
  for (const sub of SUBREDDITS) {
    try {
      const res = await fetch(`https://www.reddit.com/r/${sub}/new.json?limit=100`, {
        headers: { 'User-Agent': 'HV-Scout-Bot/3.0' }
      });
      if (!res.ok) continue;
      const data = await res.json();
      for (const post of data.data.children) {
        const text = (post.data.selftext || '') + ' ' + (post.data.url || '');
        const urls = text.match(/https?:\/\/[^\s"'()]+/g) || [];
        urls.filter(isValidUrl).forEach(u => discovered.push({ url: u, source: `r/${sub}` }));
      }
    } catch (err) {
      console.log(`Failed to mine r/${sub}: ${err.message}`);
    }
  }

  const selectedQueries = REDDIT_QUERIES_POOL.sort(() => 0.5 - Math.random()).slice(0, 8);
  console.log(`🌍 Combing Reddit Search for ${selectedQueries.length} random keyword combinations...`);
  
  for (const query of selectedQueries) {
    try {
      const res = await fetch(`https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&t=week&limit=100`, {
        headers: { 'User-Agent': 'HV-Scout-Bot/3.0' }
      });
      if (!res.ok) continue;
      const data = await res.json();
      for (const post of data.data.children) {
        const text = (post.data.selftext || '') + ' ' + (post.data.url || '');
        const urls = text.match(/https?:\/\/[^\s"'()]+/g) || [];
        urls.filter(isValidUrl).forEach(u => discovered.push({ url: u, source: `reddit_search` }));
      }
    } catch (err) {
      console.log(`Failed to search Reddit for "${query}": ${err.message}`);
    }
  }
  
  return discovered;
}

// --- 3. Directory Scraping ---
async function discoverFromDirectories() {
  const discovered = [];
  console.log('🕸️ Scraping known directories...');
  for (const dir of DIRECTORIES) {
    try {
      const res = await fetch(dir, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) continue;
      const html = await res.text();
      const urls = html.match(/href="https?:\/\/[^"]+"/g) || [];
      urls.map(u => u.replace('href="', '').replace('"', '')).filter(isValidUrl).forEach(u => discovered.push({ url: u, source: 'directory' }));
    } catch (err) {
      console.log(`Failed to scrape ${dir}: ${err.message}`);
    }
  }
  return discovered;
}

// --- Deep HTML & Social Extraction ---
async function validateAndExtract(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const html = await res.text();
    
    let title = (html.match(/<title>([^<]+)<\/title>/i) || [])[1] || new URL(url).hostname;
    title = title.replace(/\s+/g, ' ').trim();

    let desc = (html.match(/<meta[^>]*name="description"[^>]*content="([^"]+)"/i) || [])[1] || '';
    if (!desc) desc = (html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]+)"/i) || [])[1] || '';
    
    const discord = (html.match(/https?:\/\/(?:www\.)?(?:discord\.gg|discordapp\.com\/invite)\/[a-zA-Z0-9-]+/i) || [])[0] || null;
    const twitter = (html.match(/https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/[a-zA-Z0-9_]+/i) || [])[0] || null;

    return { title, desc, discord, twitter, live: true };
  } catch (err) {
    return null;
  }
}

// --- Wayback Machine Trust Scoring ---
async function fetchWaybackAge(url) {
  try {
    const res = await fetch(`https://archive.org/wayback/available?url=${url}`);
    if (!res.ok) return 0;
    const data = await res.json();
    if (data.archived_snapshots && data.archived_snapshots.closest) {
      const timestamp = data.archived_snapshots.closest.timestamp; 
      const year = parseInt(timestamp.substring(0, 4));
      const currentYear = new Date().getFullYear();
      const age = currentYear - year;
      return age > 5 ? 0.4 : (age > 2 ? 0.2 : 0);
    }
  } catch (err) {}
  return 0;
}

function guessCategory(domain, title) {
  const d = (domain + ' ' + title).toLowerCase();
  // A doujin reader, game portal or forum with "hentai" in its name is not a streaming site.
  if (d.includes('hentai')) return specificCategory(title, domain) || 'Hentai Streaming';
  if (d.includes('doujin') || d.includes('manga') || d.includes('nhentai') || d.includes('fakku')) return 'Manga & Doujinshi';
  if (d.includes('anime') && !d.includes('hentai')) return 'Anime Streaming';
  if (d.includes('booru') || d.includes('gelbooru') || d.includes('danbooru') || d.includes('rule34') || d.includes('safebooru')) return 'Image Boards (Boorus)';
  if (d.includes('torrent') || d.includes('nyaa') || d.includes('download') || d.includes('dl.')) return 'Downloads & Torrents';
  if (d.includes('visual novel') || d.includes('eroge') || d.includes('nutaku') || d.includes('f95')) return 'Games & Visual Novels';
  if (d.includes('game') || d.includes('play') || d.includes('itch.io')) return 'Games & Visual Novels';
  if (d.includes('vr') || d.includes('interactive') || d.includes('360')) return 'Immersive & Interactive';
  if (d.includes('cam') || d.includes('onlyfans') || d.includes('fansly') || d.includes('patreon') || d.includes('fans')) return 'Creator Platforms';
  if (d.includes('forum') || d.includes('community') || d.includes('discord') || d.includes('reddit')) return 'Communities & Forums';
  // Only fall back to Adult Tubes if the domain/title is clearly adult video
  if (d.includes('tube') || d.includes('porn') || d.includes('xxx') || d.includes('xnxx') || d.includes('xvideos') || d.includes('jav')) return 'Adult Tubes & Studios';
  // Unknown — return null to signal this entry should be skipped rather than miscategorised
  return null;
}

// --- Main Pipeline ---
async function run() {
  console.log(`\n🚀 HentaiVault Scout V3 — ${new Date().toISOString().split('T')[0]}`);
  const started = Date.now();

  const existingUrls = getExistingUrls();
  const existingHosts = new Set([...existingUrls].flatMap(u => [hostKey(u), siteKey(u), brandKey(u)]).filter(Boolean));
  console.log(`📦 Loaded ${existingUrls.size} existing URLs (${existingHosts.size} sites) to deduplicate against.`);
  // Without the existing set there is nothing to spider and nothing to de-duplicate
  // against, so a run would only re-queue listed sites.
  if (!existingUrls.size) throw new Error('no existing URLs loaded (pass --existing-urls); refusing to run');

  const sources = {
    spider: await discoverFromSpidering(existingUrls),
    reddit: await discoverFromReddit(),
    directories: await discoverFromDirectories(),
  };

  // Every link becomes its site's homepage; one candidate per site.
  const seenHosts = new Set();
  const candidates = [];
  for (const [source, links] of Object.entries(sources)) {
    let fresh = 0;
    for (const link of links) {
      let home = toHomepage(link.url);
      const key = home && siteKey(home);
      const brand = home && brandKey(home);
      if (!key || [key, brand].some(k => k && (existingHosts.has(k) || seenHosts.has(k)))) continue;
      // de.example.com → https://example.com/ (the site itself, not one edition)
      if (key !== hostKey(home)) home = `${new URL(home).protocol}//${key}/`;
      if (isJunkUrl(home)) continue;
      seenHosts.add(key);
      if (brand) seenHosts.add(brand);
      candidates.push(home);
      fresh++;
    }
    console.log(`   ${source}: ${links.length} links -> ${fresh} new sites`);
  }
  console.log(`\n🎯 Found ${candidates.length} unique, brand-new sites to validate (checking up to ${MAX_CANDIDATES}).`);

  const validSites = [];
  const skipped = { unreachable: 0, offTopic: 0, uncategorised: 0, lowScore: 0 };

  await pool(candidates.slice(0, MAX_CANDIDATES), VALIDATE_CONCURRENCY, async url => {
    if (Date.now() - started > RUN_BUDGET_MS) return;

    const extracted = await validateAndExtract(url);
    if (!extracted) { skipped.unreachable++; return; }

    const domain = new URL(url).hostname;
    // Must look on-topic before spending a scoring pass on it.
    if (!isTopical(domain, extracted.title, extracted.desc)) { skipped.offTopic++; return; }

    const category = guessCategory(domain, extracted.title);
    // Skip entries we cannot reliably categorise — better to miss than to pollute
    if (!category) { skipped.uncategorised++; return; }

    // Homepage titles are SEO strings ("Free Porn Videos | Brand"): use the brand.
    const name = cleanName(siteName(extracted.title, url), url);

    const { score, signals } = await scoreSite(url, category, extracted.title);
    if (score < 3.5) { skipped.lowScore++; return; }

    console.log(`   ⭐ Score ${score}/5.0 — adding to queue: ${url}`);

    let siteData = {
      name,
      url: url,
      category: category,
      description: extracted.desc || `${domain} is a great resource for ${category.toLowerCase()}.`,
      rating: score,
      tags: ['ScoutV3', 'New'],
      addedAt: new Date().toISOString().split('T')[0],
      scoreSignals: signals,
    };

    if (extracted.discord) siteData.discord = extracted.discord;
    if (extracted.twitter) siteData.twitter = extracted.twitter;

    validSites.push(siteData);
  });

  console.log(`\n📊 Queued ${validSites.length} | skipped: ${Object.entries(skipped).map(([k, v]) => `${k}=${v}`).join(', ')}` +
    ` | ${Math.round((Date.now() - started) / 60000)} min`);

  if (validSites.length > 0) {
    const crypto = require('crypto');
    let sql = '';
    for (const s of validSites) {
      // Final gate for every discovery source, not just spidered links.
      if (isJunkUrl(s.url) || !isMinorSafe(s.url, s.name, s.description)) continue;
      const id = crypto.randomUUID();
      const url = String(s.url).replace(/'/g, "''");
      const cat = String(s.category || '').replace(/'/g, "''");
      const name = String(s.name || '').replace(/'/g, "''");
      sql += `INSERT OR IGNORE INTO queue (id, url, category, name, status) VALUES ('${id}', '${url}', '${cat}', '${name}', 'pending');\n`;
    }
    const sqlFile = path.resolve(__dirname, 'scout-inserts.sql');
    fs.writeFileSync(sqlFile, sql, 'utf8');
    console.log(`\n💾 Wrote ${validSites.length} new sites to scout-inserts.sql`);
  } else {
    console.log(`\n⚠️ No new valid sites found today.`);
  }
}

if (require.main === module) {
  run().catch(err => {
    console.error('❌ Fatal error in Scout V3:', err.message);
    process.exit(1);
  });
}

module.exports = { discoverFromSpidering };
