/**
 * Helpers for site discovery (scripts/scout-v3.js) and intake (scripts/daily-add.js).
 * Pure functions; covered by scripts/test/discovery.test.mjs.
 */
'use strict';

// Two-label public suffixes common among this niche's domains (a small stand-in for
// the full Public Suffix List: enough to keep "site.co.uk" from becoming "co.uk").
const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'com.br', 'net.br', 'com.au', 'net.au', 'co.jp', 'ne.jp', 'or.jp',
  'co.kr', 'or.kr', 'com.cn', 'net.cn', 'com.tw', 'com.hk', 'co.nz', 'co.za', 'com.mx', 'com.ar',
  'co.in', 'co.id', 'com.my', 'com.sg', 'com.ph', 'com.vn', 'com.tr', 'com.ua', 'com.ru', 'co.il',
]);

/** Lower-case host without leading www./m. — the key used to de-duplicate sites. */
function hostKey(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^(www|m)\./, '');
  } catch { return null; }
}

// Language/edition subdomains (de.example.com, pt-br.example.com, m.example.com) are
// the same site as example.com; anything else (sukebei.nyaa.si) may be its own site.
const EDITION_LABEL_RE = /^([a-z]{2}(-[a-z]{2})?|www\d?|m|mobile|amp)$/;

/** De-duplication key: the host, with language/edition subdomains folded into the domain. */
function siteKey(url) {
  const host = hostKey(url);
  if (!host) return null;
  const labels = host.split('.');
  const domain = registrableDomain(host);
  if (domain && labels.length > domain.split('.').length && EDITION_LABEL_RE.test(labels[0])) return domain;
  return host;
}

/**
 * Mirror key: a site on its own registrable domain is keyed by the domain's first
 * label, so mirrors on other TLDs (drtuber.desi, drtuber.club) count as one site.
 * Sites on a subdomain (foo.blogspot.com, sukebei.nyaa.si) have none: there the
 * label names the host platform, not the site.
 */
function brandKey(url) {
  const key = siteKey(url);
  const domain = key && registrableDomain(key);
  return domain && domain === key ? domain.split('.')[0] : null;
}

/** The site's homepage for any link into it (https unless the link was plain http). */
function toHomepage(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname.includes('.') || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) return null;
    return `${u.protocol}//${u.hostname.toLowerCase()}/`;
  } catch { return null; }
}

/** example.com for a.b.example.com; example.co.uk for a.example.co.uk. */
function registrableDomain(host) {
  const labels = String(host || '').toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join('.');
  const take = MULTI_PART_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.length >= take ? labels.slice(-take).join('.') : null;
}

// Words that mark a site as on-topic for the directory (adult, hentai or anime).
// Generic words like "game" or "play" are deliberately absent: they let gaming news
// sites in. Matched against the host, page title, description or page text.
const TOPIC_RE = new RegExp([
  'hentai', 'h-?manga', 'doujin', 'ecchi', 'rule ?34', 'booru', 'eroge', 'nsfw', 'porn', 'xxx',
  'adult', 'sex', 'erotic', 'lewd', 'nude', 'naked', 'fetish', 'futanari', 'futa', 'yaoi', 'yuri',
  'ahegao', 'waifu', 'cosplay', 'jav', 'onlyfans', 'fansly', 'cam(s|girls?|show)?\\b', 'strip',
  'anime', 'manga', 'manhwa', 'manhua', 'webtoon', 'visual ?novel', 'otaku', 'animation', 'fansub',
  'r18', '18\\+', 'エロ', 'アダルト', '同人', 'アニメ', '漫画', 'エッチ',
].join('|'), 'i');

function isTopical(...parts) {
  return TOPIC_RE.test(parts.filter(Boolean).join(' '));
}

/**
 * A short site name from an SEO-style homepage title ("Free Porn Videos | Brand",
 * "Brand - Watch Hentai Online"), falling back to the domain's own label.
 */
function siteName(title, url) {
  const host = hostKey(url) || '';
  const label = (registrableDomain(host) || host).split('.')[0];
  const fromDomain = label ? label.charAt(0).toUpperCase() + label.slice(1) : '';
  const parts = String(title || '').replace(/\s+/g, ' ').trim()
    .split(/\s+[|–—•·:»]\s+|\s+-\s+/).map(p => p.trim()).filter(Boolean);
  const short = parts.filter(p => p.length <= 40 && p.split(' ').length <= 5);
  const squash = t => t.toLowerCase().replace(/[^a-z0-9]/g, '');
  const brand = short.find(p => label && (squash(p).includes(squash(label)) || squash(label).includes(squash(p))));
  if (brand) return brand;
  if (parts.length === 1 && short.length === 1) return short[0];
  return fromDomain;
}

// ── Listing names and categories ─────────────────────────────────────────────

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", raquo: '»', laquo: '«', ndash: '–', mdash: '—', hellip: '…', nbsp: ' ' };
function decodeEntities(s) {
  return String(s ?? '').replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return n > 31 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const squash = t => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Separators of SEO titles: "Brand | Tagline", "Brand - Tagline", "Brand » Tagline", "Brand: Tagline".
const TITLE_SEPARATORS = /\s+[|–—•·»«]\s+|\s+-\s+|:\s+/;
// Subdomain labels that name a section, not the site (forum.kinkoid.com).
const GENERIC_HOST_LABELS = new Set([
  'www', 'm', 'mobile', 'en', 'forum', 'forums', 'community', 'blog', 'shop', 'store', 'app',
  'members', 'member', 'wiki', 'go', 'my', 'web', 'home', 'portal', 'free', 'live', 'video', 'videos',
]);
// Longer than this with no recognisable brand, a stored name is a page title or a
// fragment of one ("Free Manhwa Hentai & Hentai Manhwa Updated Liv").
const MAX_PLAIN_NAME = 30;

/**
 * A listing's display name from what was scraped: HTML entities decoded, and an
 * SEO page title cut down to the brand ("Hentai Pulse » The Best Hentai Streaming
 * Sit" → "Hentai Pulse"). A long title with no brand in it becomes the host name.
 * Short names without a separator are left as they are.
 */
// Titles of bot-check and error pages, scraped instead of the site's own title.
const CHALLENGE_TITLE = /checking your browser|just a moment|one moment,? please|please wait|security check|ddos-guard|attention required|access denied/i;

function cleanName(name, url) {
  const decoded = decodeEntities(name).replace(/\s+/g, ' ').trim();
  const host = hostKey(url) || '';
  if (!host) return decoded;
  if (CHALLENGE_TITLE.test(decoded)) return host;
  const first = host.split('.')[0];
  const keys = [...new Set([(registrableDomain(host) || host).split('.')[0], GENERIC_HOST_LABELS.has(first) ? '' : first])]
    .map(squash).filter(k => k.length >= 3);
  const parts = decoded.split(TITLE_SEPARATORS).map(p => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    // A part names the domain when it contains it without much else ("Ani.ME" for
    // ani.me, not "Discover Anime Shows to Watch"), or is most of it (not a cut-off
    // fragment like "Free-Str"). The closest match wins.
    const distance = s => Math.min(...keys.map(k =>
      (s.includes(k) && s.length <= 2 * k.length + 6) || (k.includes(s) && s.length >= 0.6 * k.length)
        ? Math.abs(s.length - k.length) : Infinity));
    const best = parts
      .filter(p => p.length <= 40 && squash(p).length >= 3)
      .map(p => ({ p, d: distance(squash(p)) }))
      .filter(x => x.d < Infinity)
      .sort((a, b) => a.d - b.d)[0];
    if (best) return best.p;
  }
  if (!decoded || decoded.length > MAX_PLAIN_NAME) return host;
  return decoded;
}

// Signals for what a "hentai" site is. Discovery used to file every site with
// "hentai" in it under Hentai Streaming, doujin readers and game portals included.
const VIDEO_RE = /stream|watch|\bvideos?\b|episodes?|\bova\b|\bmovies?\b|\btube\b|\bjav\b/;
const SPECIFIC_CATEGORIES = [
  ['Manga & Doujinshi', /doujin|manga|manhwa|manhua|webtoon|\bcomics?\b|quadrinhos|\bhqs?\b|nhentai|hentaifox|hitomi|e-?hentai|\breader\b|read online/],
  ['Games & Visual Novels', /\bgames?\b|eroge|visual novels?|nutaku|f95/],
  ['Communities & Forums', /\bforums?\b|\bcommunit(?:y|ies)\b|discussion board|discord/],
  ['Image Boards (Boorus)', /booru|image ?board|rule ?34/],
  ['Downloads & Torrents', /torrents?|\bnyaa\b|direct downloads?|\bddl\b/],
];

/**
 * The specific category a site's text points to when it is not a video site, or
 * null. Only an unambiguous signal counts: no video words, and exactly one category.
 */
function specificCategory(...parts) {
  const text = decodeEntities(parts.filter(Boolean).join(' ')).toLowerCase()
    // Discovery's filler description names the old category; it is not a signal.
    .replace(/is a great resource for [^.]*\./g, '');
  if (VIDEO_RE.test(text)) return null;
  const hits = SPECIFIC_CATEGORIES.filter(([, re]) => re.test(text)).map(([c]) => c);
  return hits.length === 1 ? hits[0] : null;
}

/** Runs fn over items with at most `limit` in flight. */
async function pool(items, limit, fn) {
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

module.exports = {
  hostKey, siteKey, brandKey, toHomepage, registrableDomain, isTopical, siteName, pool,
  decodeEntities, cleanName, specificCategory,
};
