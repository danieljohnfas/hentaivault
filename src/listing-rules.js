/**
 * Which listings are offered to search engines (sitemap, IndexNow, robots meta).
 * Shared by the Worker and the Node scripts/tests; scripts/test/listing-rules.test.mjs
 * covers every condition.
 *
 * A listing is indexable only while all of these hold:
 *   - its URL is a site's homepage (http/https, no path or query)
 *   - it is rated MIN_INDEXABLE_RATING or higher
 *   - it is online (not marked down by the health checks or flagged dead)
 *   - its category is not in NOINDEX_CATEGORIES (aliases included)
 *   - it is not tagged Auto-Discovered (unreviewed)
 *   - its name is a real name, not a scraping artefact
 *   - it passes the minor-safety rules (src/prohibited.js)
 *   - it has been released (data_json.releasedAt): new listings go live on the site
 *     at once but are offered to search engines gradually, at most
 *     DAILY_RELEASE_LIMIT a day, best-rated first (scripts/indexnow.mjs), so a large
 *     intake never reaches Google as a sudden flood of new templated pages
 */
import { isListingVisible } from './prohibited.js';

// Canonical category names (must match ALL_CATEGORIES in js/app.js).
export const CATEGORIES = [
  'Manga & Doujinshi', 'Hentai Streaming', 'Anime Streaming', 'Image Boards (Boorus)',
  'Games & Visual Novels', 'Communities & Forums', 'Downloads & Torrents',
  'Adult Tubes & Studios', 'Creator Platforms', 'Immersive & Interactive',
];

// Legacy names still used by the submit forms and some older D1 rows.
export const CATEGORY_ALIASES = {
  'Manga/Doujin': 'Manga & Doujinshi', 'Manga': 'Manga & Doujinshi', 'Doujinshi': 'Manga & Doujinshi',
  'Images/Boorus': 'Image Boards (Boorus)', 'Boorus': 'Image Boards (Boorus)',
  'Games': 'Games & Visual Novels', 'Visual Novels': 'Games & Visual Novels', 'Adult Games': 'Games & Visual Novels',
  'Communities': 'Communities & Forums', 'Downloads': 'Downloads & Torrents',
  'Adult Studios': 'Adult Tubes & Studios', 'Adult VR': 'Immersive & Interactive',
  'Premium Creators': 'Creator Platforms', 'Anime': 'Anime Streaming',
};

export function normalizeCategory(cat) {
  const c = String(cat || '').trim();
  return CATEGORY_ALIASES[c] || c;
}

export function categoryVariants(cat) {
  const canonical = normalizeCategory(cat);
  return [canonical, ...Object.keys(CATEGORY_ALIASES).filter(k => CATEGORY_ALIASES[k] === canonical)];
}

// Listings in these categories stay browsable but are not offered to search
// engines: they are generic tube sites outside the directory's hentai/anime focus.
export const NOINDEX_CATEGORIES = new Set(['Adult Tubes & Studios']);
export const MIN_INDEXABLE_RATING = 3.5;

// Names that are scraping artefacts (challenge/error pages, bare subdomain labels)
// rather than a real site name.
export const JUNK_NAME_RE = /checking your browser|just a moment|one moment,? please|please wait|security check|ddos-guard|attention required|access denied|forbidden|not found|age verification|^(www|m|[a-z]{2,3})$/i;

// Generic subdomain labels that get scraped as a "name" (free.example.com → "Free").
const GENERIC_LABELS = new Set([
  'free', 'live', 'photo', 'photos', 'video', 'videos', 'movie', 'movies', 'members', 'member',
  'partners', 'partner', 'affiliate', 'affiliates', 'exchange', 'landing', 'enter', 'join', 'tour',
  'preview', 'gallery', 'galleries', 'cams', 'cam', 'chat', 'mobile', 'app', 'api', 'auth', 'static',
  'cdn', 'img', 'images', 'media', 'blog', 'shop', 'store', 'support', 'help', 'login', 'signup', 'home',
]);

export function isJunkName(name, url) {
  const n = String(name || '').trim();
  if (!n || JUNK_NAME_RE.test(n)) return true;
  const word = n.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!GENERIC_LABELS.has(word)) return false;
  try {
    const labels = new URL(url).hostname.toLowerCase().replace(/^www\./, '').split('.');
    // A generic word is only a real name when it is the brand itself (live.com), not a subdomain.
    return labels.length >= 3 || labels[0] !== word;
  } catch { return true; }
}

export function isSafeHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

const FALSY = new Set([false, 0, 'false', '0']);
const TRUTHY = new Set([true, 1, 'true', '1']);

export function isSiteUp(site) {
  return !(FALSY.has(site.isUp) || TRUTHY.has(site.isDeadFlagged));
}

export function parseTags(tags) {
  if (Array.isArray(tags)) return tags;
  try { const t = JSON.parse(tags || '[]'); return Array.isArray(t) ? t : []; } catch { return []; }
}

export function isHomepageUrl(url) {
  try {
    const u = new URL(url);
    return u.pathname.replace(/\/+$/, '') === '' && !u.search;
  } catch { return false; }
}

export const DAILY_RELEASE_LIMIT = 100;

// Static pages listed in the sitemap ahead of the listings. Only real, indexable
// documents; they carry no <lastmod> (stamping "today" on every request teaches
// Google to ignore the field).
export const SITEMAP_STATIC_PAGES = [
  '/', '/blog/',
  '/blog/nhentai-alternatives-2026', '/blog/best-streaming-2026', '/blog/best-doujin-sites-2026',
  '/blog/hentai-apps-guide-2026', '/blog/uncensored-streaming-guide-2026', '/blog/free-manga-guide',
  '/blog/hanime-alternatives-2026', '/blog/privacy-safety-guide', '/blog/top-10-sites-may-2026',
  '/category/anime-streaming', '/category/hentai-streaming', '/category/manga-doujin',
  '/category/images-boorus', '/category/games', '/category/communities', '/category/downloads',
  '/category/visual-novels', '/region-unblocked',
  '/about', '/contact', '/privacy', '/terms', '/disclaimer', '/dmca',
];

/** Meets every sitemap condition except release (what the daily release picks from). */
export function isIndexCandidate(site) {
  if (!site || !isSafeHttpUrl(site.url)) return false;
  if (!isHomepageUrl(site.url)) return false;
  if (!isListingVisible(site)) return false;
  if (!isSiteUp(site)) return false;
  if (!(Number(site.rating) >= MIN_INDEXABLE_RATING)) return false;
  if (NOINDEX_CATEGORIES.has(normalizeCategory(site.category))) return false;
  if (parseTags(site.tags).includes('Auto-Discovered')) return false;
  if (isJunkName(site.name, site.url)) return false;
  return true;
}

/** Whether a listing's review page should be indexed and included in the sitemap. */
export function isIndexable(site) {
  return isIndexCandidate(site) && Boolean(site.releasedAt);
}
