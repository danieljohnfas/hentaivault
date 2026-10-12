#!/usr/bin/env node
/**
 * daily-add.js — HentaiVault Daily Site Addition Pipeline
 *
 * Usage:
 *   node scripts/daily-add.js [--count 100] [--dry-run]
 *                             [--existing-urls /path/to/urls.json]
 *                             [--output-sql /path/to/output.sql]
 *
 * What it does:
 *   1. Reads the queue from scripts/sites-queue.json
 *   2. Deduplicates against existing URLs (from --existing-urls file or sites-queue itself)
 *   3. Picks the next N sites (default: 100), pinging each to confirm liveness
 *   4. Procedurally enriches each site with multi-language content
 *   5. Writes SQL INSERT statements to --output-sql (or stdout if omitted)
 *   6. Removes processed/dead entries from the queue file
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const isSiteLive = require('./ping-site');
const { scoreSite } = require('./score-site');
const { isMinorSafe } = require('../src/prohibited.js');
const { isJunkName } = require('../src/listing-rules.js');
const { isTopical, pool, cleanName, specificCategory } = require('./lib/discovery.js');

// ─── Config ─────────────────────────────────────────────────────────────────
const ROOT       = path.resolve(__dirname, '..');

const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const COUNT   = parseInt((args[args.findIndex(a => a === '--count') + 1]) || '150', 10) || 150;

const existingUrlsFlag = args.findIndex(a => a === '--existing-urls');
const EXISTING_URLS_FILE = existingUrlsFlag !== -1 ? args[existingUrlsFlag + 1] : null;

const outputSqlFlag = args.findIndex(a => a === '--output-sql');
const OUTPUT_SQL_FILE = outputSqlFlag !== -1 ? args[outputSqlFlag + 1] : null;

const queueFileFlag = args.findIndex(a => a === '--queue-file');
const QUEUE_FILE = queueFileFlag !== -1 ? args[queueFileFlag + 1] : null;

const outputQueueSqlFlag = args.findIndex(a => a === '--output-queue-sql');
const OUTPUT_QUEUE_SQL_FILE = outputQueueSqlFlag !== -1 ? args[outputQueueSqlFlag + 1] : null;

// ─── Helpers ────────────────────────────────────────────────────────────────
function today() {
  return new Date().toISOString().split('T')[0];
}

function makeId(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 30);
}

function escapeSql(str) {
  return String(str || '').replace(/'/g, "''");
}

// ─── Junk Filter (second gate after Scout) ──────────────────────────────────
// Blocks individual content pages, documents, non-adult sites, and
// any URL that was never a site homepage from reaching D1.
const JUNK_DOMAIN_BLACKLIST = [
  'eneba.com', 'steampowered.com', 'scribd.com', 'animeonegai.com',
  'securities.dmm.com', 'zerotolerance.com', 'zline0.com',
  'docs.google.com', 'drive.google.com', 'medium.com', 'substack.com',
  'apps.apple.com', 'play.google.com',
];
const JUNK_PATH_PATTERNS = [
  /\.pdf($|\?)/i,
  /\/videos?\/[^/]+/i,
  /\/bucetas?\//i,
  /\/document\//i,
  /\/curator\//i,
  /\/news\//i,
  /\/policy\//i,
  /anti.?trafficking/i,
  /\/hub\/news/i,
  /\/performance\/?$/i,
];

// Accepts "/", "/en", "/en/", "/home" and "/index.html"; anything deeper is a sub-page.
function isHomepagePath(u) {
  if (u.search) return false;
  const segments = u.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return true;
  return segments.length === 1 && /^([a-z]{2}(-[a-z]{2})?|home|index\.(html?|php))$/i.test(segments[0]);
}

function isJunkSite(site) {
  try {
    const u = new URL(site.url);
    const domain = u.hostname.toLowerCase().replace(/^www\./, '');
    // Blacklisted domains
    if (JUNK_DOMAIN_BLACKLIST.some(d => domain === d || domain.endsWith('.' + d))) return true;
    // Junk path patterns
    if (JUNK_PATH_PATTERNS.some(p => p.test(site.url))) return true;
    // Minor safety: nothing blocked or needing manual review is published automatically.
    if (!isMinorSafe(site.url, site.name, site.description, site.tags)) return true;
    // Only site homepages: performer, category, search and article pages are not "sites".
    if (!isHomepagePath(u)) return true;
    // Name looks like a sentence/headline rather than a brand name
    const name = String(site.name || '');
    // Scraping artefacts: challenge/error pages or subdomain labels as the name
    if (isJunkName(name, site.url)) return true;
    if (name.length > 70 || name.trim().split(/\s+/).length > 8) return true;
    return false;
  } catch {
    return true; // unparseable URL = junk
  }
}

function siteToSql(site) {
  const id       = escapeSql(site.id);
  const category = escapeSql(site.category);
  const url      = escapeSql(site.url);
  const rating   = site.rating || 0;
  const addedAt  = escapeSql(site.addedAt || today());
  const dataJson = escapeSql(JSON.stringify(site));
  return `INSERT OR IGNORE INTO sites (id, category, url, rating, added_at, data_json) VALUES ('${id}', '${category}', '${url}', ${rating}, '${addedAt}', '${dataJson}');`;
}

// ─── Procedural Enrichment ──────────────────────────────────────────────────
const CAT_DESCRIPTORS = {
  'Hentai Streaming':       { adj: 'hentai streaming', niche: 'anime adult video' },
  'Anime Streaming':        { adj: 'anime streaming', niche: 'Japanese animation' },
  'Manga & Doujinshi':      { adj: 'manga and doujin', niche: 'Japanese comics and fan works' },
  'Communities & Forums':   { adj: 'community and forum', niche: 'discussion and social' },
  'Adult Tubes & Studios':  { adj: 'adult video', niche: 'premium adult content' },
  'Games & Visual Novels':  { adj: 'adult game and visual novel', niche: 'interactive adult entertainment' },
  'Immersive & Interactive':{ adj: 'immersive VR and interactive', niche: 'virtual reality adult' },
  'Image Boards (Boorus)':  { adj: 'image board and booru', niche: 'anime artwork and illustration' },
  'Downloads & Torrents':   { adj: 'download and torrent', niche: 'file sharing and archiving' },
  'Creator Platforms':      { adj: 'creator and fan platform', niche: 'adult content creator' },
  'default':                { adj: 'adult entertainment', niche: 'adult content' },
};

function getDesc(cat) {
  return CAT_DESCRIPTORS[cat] || CAT_DESCRIPTORS['default'];
}

function enrich(site) {
  // Scraped names are often SEO page titles; anything with "hentai" in it used to
  // be filed under Hentai Streaming whatever it was (scripts/lib/discovery.js).
  const metaDesc = site.scoreSignals && site.scoreSignals.metaDesc;
  const name = cleanName(site.name, site.url);
  const cat  = (site.category === 'Hentai Streaming' && specificCategory(site.name, metaDesc || site.description, site.url)) || site.category;
  const d    = getDesc(cat);
  const id   = makeId(name) + '_' + Date.now().toString(36);
  const dt   = today();
  const rating = site.rating || 0;

  // Only state what the pipeline actually measured. No invented "editorial
  // audits", superlatives or boilerplate pros/cons: thousands of identical
  // claims across listings is what Google classifies as scaled low-value content.
  const longReview =
    `${name} is a ${d.adj} site listed on HentaiVault since ${dt}. ` +
    `Our automated checks (availability, HTTPS, response time and on-page signals) scored it ` +
    `${rating.toFixed(1)}/5. Scores are refreshed as the site is re-checked.`;

  let finalDesc = `${name} — ${d.adj} site.`;
  if (site.scoreSignals && site.scoreSignals.metaDesc && site.scoreSignals.metaDesc.length > 10) {
    finalDesc = site.scoreSignals.metaDesc;
  } else if (site.description) {
    finalDesc = site.description;
  }

  const entry = {
    id,
    name,
    url: site.url,
    category: cat,
    description: finalDesc,
    addedAt: dt,
    longReview,
    rating,
    tags: site.tags || [cat.split(' ')[0]],
  };
  if (Array.isArray(site.pros) && site.pros.length) entry.pros = site.pros;
  if (Array.isArray(site.cons) && site.cons.length) entry.cons = site.cons;
  return entry;
}

// ─── Main ────────────────────────────────────────────────────────────────────
function writeQueueUpdates(queue, addedUrls) {
  if (!OUTPUT_QUEUE_SQL_FILE || DRY_RUN) return;
  let sql = '';
  for (const site of queue) {
    if (!site.id) continue;
    const status = addedUrls.has(site.url) ? 'done' : 'rejected';
    sql += `UPDATE queue SET status = '${status}' WHERE id = '${site.id}';\n`;
  }
  fs.mkdirSync(require('path').dirname(OUTPUT_QUEUE_SQL_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_QUEUE_SQL_FILE, sql, 'utf8');
}

async function run() {
  console.log(`\n🚀 HentaiVault Daily Add — ${today()}`);
  console.log(`   Count: ${COUNT}  |  Dry-run: ${DRY_RUN}\n`);

  // 1. Load existing URLs for deduplication
  let existingUrls = new Set();
  if (EXISTING_URLS_FILE && fs.existsSync(EXISTING_URLS_FILE)) {
    const raw = JSON.parse(fs.readFileSync(EXISTING_URLS_FILE, 'utf8'));
    for (const u of raw) {
      existingUrls.add(String(u).replace(/\/$/, '').toLowerCase());
    }
    console.log(`📦 Existing entries in D1: ${existingUrls.size}`);
  } else {
    console.log(`⚠️  No --existing-urls file provided — skipping deduplication against D1.`);
  }

  // 2. Load queue
  if (!fs.existsSync(QUEUE_FILE)) {
    console.error('❌ Queue file not found:', QUEUE_FILE);
    process.exit(1);
  }
  const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  console.log(`📋 Queue size: ${queue.length}`);

  if (queue.length === 0) {
    console.log('⚠️  Queue is empty. Nothing to add.');
    process.exit(0);
  }

  // 3. Filter out already-existing URLs + run junk filter
  const fresh = queue.filter(s => {
    if (existingUrls.has(String(s.url).replace(/\/$/, '').toLowerCase())) return false;
    if (isJunkSite(s)) {
      console.log(`   ⏭️  Junk filter removed: ${s.url}`);
      return false;
    }
    return true;
  });
  console.log(`✅ New & clean (not in D1, not junk): ${fresh.length}`);

  if (fresh.length === 0) {
    console.log('⚠️  All queue items already exist in D1. Nothing to add.');
    
    writeQueueUpdates(queue, new Set());
    process.exit(0);
  }

  // 4. Ping to find N live sites
  const batch = [];
  const deadUrls = new Set();

  console.log(`\n🔍 Pinging sites (concurrency=40) to find ${COUNT} valid domains...`);

  await pool(fresh, 40, async s => {
    if (batch.length >= COUNT) return;
    const live = await isSiteLive(s.url);
    if (live === 'dead') {
      console.log(`   ❌ ${s.url} (Dead/Parked)`);
      deadUrls.add(s.url);
    } else if (batch.length < COUNT) {
      // 'error' = timed out, blocked the bot or returned 5xx: kept, since it was scouted live.
      console.log(live === 'live' ? `   ✅ ${s.url}` : `   ⚠️ ${s.url} (Ping Error / Cloudflare Blocked - Assuming Live)`);
      batch.push(s);
    }
  });

  if (batch.length === 0) {
    console.log('⚠️ No live sites found in the remaining queue!');
    writeQueueUpdates(queue, new Set());
    process.exit(0);
  }

  // 5. Score each site with real signals and filter < 4.0
  console.log(`\n🔬 Scoring ${batch.length} sites with real quality signals...`);
  const scored = [];
  await pool(batch, 10, async s => {
    const { score, signals } = await scoreSite(s.url, s.category, s.name);
    if (score < 3.5) {
      console.log(`   ⏭️  Dropped after scoring (${score}/5.0): ${s.url}`);
      return;
    }
    // Off-topic sites (gaming news, CDNs, local businesses) score well on technical
    // signals alone; the page or its name must actually be adult/hentai/anime.
    if (!signals.hasAdultSignals && !isTopical(s.url, s.name, signals.metaDesc)) {
      console.log(`   ⏭️  Dropped (off-topic): ${s.url}`);
      return;
    }
    console.log(`   ⭐ ${score}/5.0 — ${s.url}`);
    scored.push({ ...s, rating: score, scoreSignals: signals });
  });

  if (scored.length === 0) {
    console.log('⚠️ No sites passed the 3.5 quality gate after scoring.');
    if (!DRY_RUN) {
      const remaining = queue.filter(s => {
        const norm = String(s.url).replace(/\/$/, '').toLowerCase();
        return !existingUrls.has(norm) && !deadUrls.has(s.url);
      });
      fs.writeFileSync(QUEUE_FILE, JSON.stringify(remaining, null, 2), 'utf8');
    }
    process.exit(0);
  }

  // Re-check after enrichment: the scraped meta description only exists now.
  const enriched = scored.map(enrich).filter(e => {
    if (isMinorSafe(e.url, e.name, e.description, e.tags)) return true;
    console.log(`   ⛔ Blocked (minor safety): ${e.id || e.url}`);
    return false;
  });
  console.log(`\n➕ Enriched ${enriched.length} new sites`);
  enriched.forEach(s => console.log(`   · ${s.name} (${s.category})`));

  if (DRY_RUN) {
    console.log('\n🔵 Dry-run mode — no files modified.');
    process.exit(0);
  }

  // 5. Write SQL INSERT statements
  const sqlStatements = enriched.map(siteToSql).join('\n');
  if (OUTPUT_SQL_FILE) {
    fs.mkdirSync(path.dirname(OUTPUT_SQL_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_SQL_FILE, sqlStatements, 'utf8');
    console.log(`\n💾 SQL written to ${OUTPUT_SQL_FILE} (${enriched.length} INSERT statements)`);
  } else {
    console.log('\n--- SQL OUTPUT ---');
    console.log(sqlStatements);
    console.log('--- END SQL ---');
  }

  // 6. Write Queue Updates
  const addedUrls = new Set(enriched.map(s => s.url));
  writeQueueUpdates(queue, addedUrls);

  console.log(`\n✅ Done! Generated SQL for ${enriched.length} new sites.`);
}

run().catch(err => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
