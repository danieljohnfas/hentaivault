/**
 * Server-rendered links from the homepage, category hubs and guides to listing
 * pages. The browsing UI builds its cards with JavaScript, so without these the
 * crawlable HTML links to almost no listing. Pure functions over listing rows
 * (see LINK_COLUMNS); covered by scripts/test/internal-links.test.mjs.
 */
import { isIndexable, isIndexCandidate, normalizeCategory } from './listing-rules.js';

// Columns the Worker selects for the link snapshot (everything the rules need).
export const LINK_COLUMNS = `id, url, category, rating,
  json_extract(data_json, '$.name') AS name, json_extract(data_json, '$.description') AS description,
  json_extract(data_json, '$.tags') AS tags, json_extract(data_json, '$.isUp') AS isUp,
  json_extract(data_json, '$.isDeadFlagged') AS isDeadFlagged, json_extract(data_json, '$.releasedAt') AS releasedAt`;

// Category hub pages and the listings each one links to. `prefer` ranks matching
// listings first where two hubs share a category.
export const HUB_PAGES = {
  '/category/manga-doujin': { category: 'Manga & Doujinshi', label: 'Manga & Doujinshi' },
  '/category/hentai-streaming': { category: 'Hentai Streaming', label: 'Hentai Streaming' },
  '/category/anime-streaming': { category: 'Anime Streaming', label: 'Anime Streaming' },
  '/category/images-boorus': { category: 'Image Boards (Boorus)', label: 'Image Boards' },
  '/category/games': { category: 'Games & Visual Novels', label: 'Games' },
  '/category/visual-novels': { category: 'Games & Visual Novels', label: 'Visual Novels', prefer: /visual ?novel|\bvn\b|eroge/i },
  '/category/communities': { category: 'Communities & Forums', label: 'Communities & Forums' },
  '/category/downloads': { category: 'Downloads & Torrents', label: 'Downloads & Torrents' },
};

export const HUB_LINKS = 24;   // listings linked from each category hub
export const HOME_LINKS = 10;  // listings linked per category on the homepage
export const GUIDE_LINKS = 12; // listings linked from one guide

// Some stored names and descriptions still carry HTML entities from scraping
// ("Hentai Pulse &raquo; …"); decode the common ones so they are not shown literally.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", raquo: '»', laquo: '«', ndash: '–', mdash: '—', hellip: '…', nbsp: ' ' };
const decode = s => String(s ?? '').replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return n > 31 && n < 0x110000 ? String.fromCodePoint(n) : m; }
  return ENTITIES[e.toLowerCase()] ?? m;
});
const esc = s => decode(s).replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
const listingHref = id => `/site?id=${encodeURIComponent(id)}`;
const byRating = (a, b) => Number(b.rating) - Number(a.rating) || String(a.name).localeCompare(String(b.name));
const hostOf = url => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const squash = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Mirrors on other TLDs (hentaihaven.com, hentaihaven.xxx) are one brand. Sites on
// a subdomain (foo.blogspot.com) are their own brand; example.co.uk is "example".
function brandOf(s) {
  const labels = hostOf(s.url).split('.');
  const suffix = labels.length >= 3 && labels.at(-1).length === 2 && labels.at(-2).length <= 3 ? 2 : 1;
  return labels.length === suffix + 1 ? labels[0] : (labels.join('.') || s.id);
}
const ratingText = r => Number(r).toFixed(1);
const shortDesc = d => { const t = String(d || '').replace(/\s+/g, ' ').trim(); return t.length > 150 ? `${t.slice(0, 147).replace(/\s+\S*$/, '')}…` : t; };

/**
 * The best-rated indexable listings for a hub, one per brand, leaving out ids
 * already on the page and brands those ids belong to.
 */
export function topForHub(sites, hub, n, exclude = new Set()) {
  const prefer = s => (hub.prefer && hub.prefer.test(`${s.name} ${s.description} ${s.tags}`) ? 1 : 0);
  const brands = new Set(sites.filter(s => exclude.has(s.id)).map(brandOf));
  const out = [];
  for (const s of sites
    .filter(s => normalizeCategory(s.category) === hub.category && isIndexable(s) && !exclude.has(s.id))
    .sort((a, b) => prefer(b) - prefer(a) || byRating(a, b))) {
    if (out.length >= n) break;
    const brand = brandOf(s);
    if (brands.has(brand)) continue;
    brands.add(brand);
    out.push(s);
  }
  return out;
}

/** Cards in the category hubs' existing markup. */
export function renderHubCards(sites) {
  return sites.map(s => `
                <a href="${esc(listingHref(s.id))}" class="site-card">
                    <div class="card-header">
                        <span class="card-title">${esc(s.name)}</span>
                        <span class="card-rating">⭐ ${ratingText(s.rating)}</span>
                    </div>
                    <p class="card-desc">${esc(shortDesc(s.description))}</p>
                    <div class="card-footer">
                        <span>${esc(hostOf(s.url))}</span>
                        <span class="card-btn">View Review</span>
                    </div>
                </a>`).join('');
}

/** The homepage's "Top-rated by category" section body ('' when there is nothing to show). */
export function renderHomeSection(sites) {
  const seen = new Set();
  const groups = Object.entries(HUB_PAGES).map(([path, hub]) => {
    const top = topForHub(sites, hub, HOME_LINKS, seen);
    top.forEach(s => seen.add(s.id));
    if (!top.length) return '';
    return `<div class="top-sites-group"><h3><a href="${path}">${esc(hub.label)}</a></h3><ol>${
      top.map(s => `<li><a href="${esc(listingHref(s.id))}">${esc(s.name)}</a> <span class="top-sites-rating">⭐ ${ratingText(s.rating)}</span></li>`).join('')
    }</ol><a class="top-sites-more" href="${path}">All ${esc(hub.label)} →</a></div>`;
  }).filter(Boolean);
  if (!groups.length) return '';
  return `<h2 id="topSitesHeading">Top-Rated Sites by Category</h2><div class="top-sites-groups">${groups.join('')}</div>`;
}

/**
 * Name → listing lookup for matching the sites a guide writes about. Keys are the
 * squashed name, host and domain label ("E-Hentai", "e-hentai.org", "ehentai");
 * a key shared by several listings goes to the best-rated one.
 */
export function buildNameIndex(sites) {
  const index = new Map();
  for (const s of [...sites].filter(isIndexCandidate).sort(byRating).reverse()) {
    const host = hostOf(s.url);
    for (const key of [squash(s.name), squash(host), squash(host.split('.')[0])]) {
      if (key.length >= 3) index.set(key, s); // best-rated last, so it wins
    }
  }
  return index;
}

/** The listing a guide heading names ("#1. Hitomi.la — Best Overall" → Hitomi.la), or null. */
export function matchHeading(text, index) {
  const lead = String(text || '').replace(/^\s*#?\d+[.)]?\s*/, '').split(/\s+[—–|-]\s+|:\s+|\s+\(/)[0];
  const key = squash(lead);
  return (key.length >= 3 && index.get(key)) || null;
}

/** The "Reviewed in this guide" box for the listings a guide's headings name. */
export function renderGuideLinks(headings, index) {
  const found = [];
  for (const h of headings) {
    const s = matchHeading(h, index);
    if (s && !found.includes(s)) found.push(s);
    if (found.length >= GUIDE_LINKS) break;
  }
  if (!found.length) return '';
  return `<aside class="guide-listings" aria-label="Sites reviewed in this guide"><h2>Full Reviews of the Sites in This Guide</h2><ul>${
    found.map(s => `<li><a href="${esc(listingHref(s.id))}">${esc(s.name)} review</a> <span>⭐ ${ratingText(s.rating)}</span></li>`).join('')
  }</ul></aside>`;
}
