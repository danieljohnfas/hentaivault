/**
 * HentaiVault — Cloudflare Worker Entry Point
 *
 * Routes:
 *   /site, /compare, /embed, /out → server-rendered pages backed by D1
 *   /api/*                        → JSON API backed by D1 / KV
 *   /sitemap.xml, /rss.xml        → generated from D1
 *   *                             → static assets (see .assetsignore)
 *
 * Secrets (Cloudflare dashboard → Worker → Settings → Variables and Secrets):
 *   TURNSTILE_SECRET_KEY — optional; when set, /api/submit and reviews verify
 *                          Cloudflare Turnstile tokens (see verifyHuman)
 *   INDEXNOW_KEY         — optional, enables IndexNow pings for new listings
 *   TYPESAFE_API_KEY     — optional Jev fallback for submission/review screening;
 *                          Clef runs through the AI binding (wrangler.jsonc)
 */

import { isMinorSafe, isListingVisible, PROHIBITED_TERMS } from './prohibited.js';
import { affiliateUrlFor } from './affiliates.js';
import {
  CATEGORIES, normalizeCategory, categoryVariants,
  isSafeHttpUrl, isSiteUp, parseTags, isIndexable, SITEMAP_STATIC_PAGES, MIN_INDEXABLE_RATING,
} from './listing-rules.js';
import {
  LINK_COLUMNS, HUB_PAGES, HUB_LINKS, topForHub, renderHubCards, renderHomeSection,
  buildNameIndex, renderGuideLinks,
} from './internal-links.js';
import { decide, noul, choice } from './decision.js';

// Clef/Jev screening (see decision.js). Thresholds were calibrated on live samples:
// real directory sites scored relevance 0.94-0.97, a loans page 0.04; a loli image board
// scored minor_risk 0.95-0.97 while a mainstream doujin library scored up to 0.64.
const SUBMISSION_QUESTIONS = {
  relevant: noul('A website submitted to an adult anime/hentai site directory. Is it actually an adult anime, hentai, manga, doujin, eroge or related creator site (not an unrelated business, malware, or a generic spam page)?'),
  minor_risk: noul('Does this submission suggest sexual content involving minors (e.g. loli, shota, child, underage, "young-looking" emphasis)?'),
};
const MIN_RELEVANCE = 0.3;
const MAX_MINOR_RISK = 0.85;

const REVIEW_QUESTIONS = {
  verdict: choice('A user review of a website, posted publicly on a site directory. Classify it.', {
    ok: 'A genuine opinion or experience, positive or negative, mild profanity allowed',
    spam: 'Advertising, scams, promotion of another site or service, or junk text',
    harmful: 'Threats, personal data about someone, hate against a protected group, or sexual content involving minors',
  }),
};

const SUPPORTED_LANGS = ['en', 'fr', 'es', 'jp', 'pt', 'hi', 'ar', 'de'];

// SQL guard appended to every listing query so prohibited entries are never served.
// Terms are constants from prohibited.js (no quotes), so inlining them is safe.
// Pattern-based (restricted) matches are removed by the minor-safety sweep.
const NOT_PROHIBITED_SQL = '(' + PROHIBITED_TERMS
  .map(t => `instr(lower(url || ' ' || COALESCE(json_extract(data_json, '$.name'), '') || ' ' || COALESCE(json_extract(data_json, '$.description'), '')), '${t}') = 0`)
  .join(' AND ') + ')';

// Parses listing rows and drops any that fail the full minor-safety check (the SQL
// guard above only knows the plain terms; the sweep removes the rest within hours).
const visibleSites = rows => rows
  .map(r => { try { return JSON.parse(r.data_json); } catch { return null; } })
  .filter(isListingVisible)
  .map(site => {
    const affiliate = affiliateUrlFor(site.url);
    return affiliate ? { ...site, affiliate_url: affiliate } : site;
  });

function escapeHTML(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>'"]/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[ch]));
}

function jsonLd(obj) {
  return `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;
}

function hostnameOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function faviconFor(url) {
  const host = hostnameOf(url);
  return host ? `https://icons.duckduckgo.com/ip3/${host}.ico` : '/assets/favicon.png';
}

const CATEGORY_HUBS = {
  'Manga & Doujinshi': '/category/manga-doujin',
  'Hentai Streaming': '/category/hentai-streaming',
  'Anime Streaming': '/category/anime-streaming',
  'Image Boards (Boorus)': '/category/images-boorus',
  'Games & Visual Novels': '/category/games',
  'Communities & Forums': '/category/communities',
  'Downloads & Torrents': '/category/downloads',
};


// Rate Limiter
const RATE_LIMIT_SECONDS = 60;
const MAX_REQS = 2;

async function checkRateLimit(ip, env) {
  if (!ip || !env.PUSH_SUBSCRIBERS) return false;
  const key = `ratelimit:${ip}`;
  try {
    let count = await env.PUSH_SUBSCRIBERS.get(key);
    count = count ? parseInt(count) : 0;
    if (count >= MAX_REQS) return true;
    
    await env.PUSH_SUBSCRIBERS.put(key, (count + 1).toString(), { expirationTtl: RATE_LIMIT_SECONDS });
    return false;
  } catch (e) {
    return false;
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// We no longer load the massive data.js file into the Worker memory.
// D1 handles all backend queries to respect the 10ms CPU limit.

class HeadHandler {
  constructor(site, canonicalUrl, lang, indexable) {
    this.site = site;
    this.canonicalUrl = canonicalUrl;
    this.lang = lang;
    this.indexable = indexable;
  }
  element(element) {
    const site = this.site;
    const title = `${site.name} Review | HentaiVault`;
    const rating = Number(site.rating) > 0 ? Number(site.rating) : null;
    const category = normalizeCategory(site.category);
    const metaDesc = [
      `${site.name}: ${category || 'site'} review on HentaiVault.`,
      rating ? `Rated ${rating}/5.` : '',
      isSiteUp(site) ? '' : 'Currently offline.',
      site.description || '',
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    const desc = (site.description || metaDesc).slice(0, 300);

    const tags = [
      `<link rel="canonical" href="${escapeHTML(this.canonicalUrl)}">`,
      `<meta name="description" content="${escapeHTML(metaDesc)}">`,
      `<meta property="og:title" content="${escapeHTML(title)}">`,
      `<meta property="og:description" content="${escapeHTML(desc)}">`,
      `<meta property="og:url" content="${escapeHTML(this.canonicalUrl)}">`,
      `<meta property="og:type" content="article">`,
      `<meta name="twitter:card" content="summary">`,
      `<meta name="twitter:title" content="${escapeHTML(title)}">`,
      `<meta name="twitter:description" content="${escapeHTML(desc)}">`,
    ];
    if (!this.indexable) tags.push('<meta name="robots" content="noindex, follow">');

    const graph = [
      {
        "@type": "Organization",
        "@id": "https://hentaivault.me/#organization",
        "name": "HentaiVault",
        "url": "https://hentaivault.me",
        "logo": { "@type": "ImageObject", "url": "https://hentaivault.me/assets/favicon.png" }
      },
      {
        "@type": "BreadcrumbList",
        "itemListElement": [
          { "@type": "ListItem", "position": 1, "name": "HentaiVault", "item": "https://hentaivault.me/" },
          ...(CATEGORY_HUBS[category] ? [{ "@type": "ListItem", "position": 2, "name": category, "item": `https://hentaivault.me${CATEGORY_HUBS[category]}` }] : []),
          { "@type": "ListItem", "position": CATEGORY_HUBS[category] ? 3 : 2, "name": site.name, "item": this.canonicalUrl }
        ]
      }
    ];
    // Only emit a Review when the listing actually has a score; never invent one.
    if (rating) {
      graph.push({
        "@type": "Review",
        "itemReviewed": { "@type": "WebSite", "name": site.name, "url": site.url },
        "reviewRating": { "@type": "Rating", "ratingValue": rating, "bestRating": 5, "worstRating": 1 },
        "author": { "@id": "https://hentaivault.me/#organization" },
        "publisher": { "@id": "https://hentaivault.me/#organization" },
        "reviewBody": desc
      });
    }
    tags.push(jsonLd({ "@context": "https://schema.org", "@graph": graph }));
    element.append(tags.join('\n'), { html: true });
  }
}

class TitleHandler {
  constructor(titleText) {
    this.titleText = titleText;
  }
  element(element) {
    element.setInnerContent(this.titleText);
  }
}

class ReviewBodyHandler {
  constructor(site, lang, sitesData) {
    this.site = site;
    this.lang = lang;
    this.sitesData = sitesData;
  }
  element(element) {
    const site = this.site;
    const domain = hostnameOf(site.url);
    const faviconUrl = faviconFor(site.url);
    const rating = Number(site.rating) > 0 ? Number(site.rating) : null;
    const category = normalizeCategory(site.category);

    const localName = escapeHTML(site[`name_${this.lang}`] || site.name);
    const localCat  = escapeHTML(category);
    const localDesc = escapeHTML(site[`description_${this.lang}`] || site.description);
    const ratingSuffix = rating ? ` (${rating}/5)` : '';

    const labels = {
        en: {
            expertReview: "Overview", pros: "Pros", cons: "Cons", conclusion: "Summary",
            conclusionText: `${localName} is listed in our ${localCat} directory${ratingSuffix}. Compare it with the similar sites below before visiting, and use an ad-blocker on adult sites.`,
            visitSite: `Visit ${localName} &rarr;`, similar: "Similar Sites You May Like"
        },
        fr: {
            expertReview: "Présentation", pros: "Points forts", cons: "Points faibles", conclusion: "Résumé",
            conclusionText: `${localName} figure dans notre annuaire ${localCat}${ratingSuffix}. Comparez-le avec les sites similaires ci-dessous avant de le visiter et utilisez un bloqueur de publicités.`,
            visitSite: `Visiter ${localName} &rarr;`, similar: "Sites similaires que vous pourriez aimer"
        },
        es: {
            expertReview: "Resumen", pros: "Pros", cons: "Contras", conclusion: "Conclusión",
            conclusionText: `${localName} aparece en nuestro directorio de ${localCat}${ratingSuffix}. Compáralo con los sitios similares de abajo antes de visitarlo y usa un bloqueador de anuncios.`,
            visitSite: `Visitar ${localName} &rarr;`, similar: "Sitios similares que le pueden gustar"
        },
        jp: {
            expertReview: "概要", pros: "メリット", cons: "デメリット", conclusion: "まとめ",
            conclusionText: `${localName}は当ディレクトリの${localCat}カテゴリに掲載されています${ratingSuffix}。訪問前に下の類似サイトと比較し、広告ブロッカーの利用をおすすめします。`,
            visitSite: `${localName}を訪問する &rarr;`, similar: "あなたにおすすめの類似サイト"
        },
        pt: {
            expertReview: "Visão geral", pros: "Prós", cons: "Contras", conclusion: "Resumo",
            conclusionText: `${localName} está listado no nosso diretório de ${localCat}${ratingSuffix}. Compare-o com os sites semelhantes abaixo antes de visitar e use um bloqueador de anúncios.`,
            visitSite: `Visitar ${localName} &rarr;`, similar: "Sites semelhantes que você pode gostar"
        },
        hi: {
            expertReview: "अवलोकन", pros: "खूबियां", cons: "खामियां", conclusion: "सारांश",
            conclusionText: `${localName} हमारी ${localCat} निर्देशिका में सूचीबद्ध है${ratingSuffix}। जाने से पहले नीचे दी गई समान साइटों से तुलना करें और विज्ञापन-अवरोधक का उपयोग करें।`,
            visitSite: `${localName} पर जाएं &rarr;`, similar: "समान साइटें जो आपको पसंद आ सकती हैं"
        },
        ar: {
            expertReview: "نظرة عامة", pros: "الإيجابيات", cons: "السلبيات", conclusion: "الخلاصة",
            conclusionText: `${localName} مدرج في دليل ${localCat} لدينا${ratingSuffix}. قارنه بالمواقع المشابهة أدناه قبل الزيارة واستخدم مانع الإعلانات.`,
            visitSite: `زيارة ${localName} &rarr;`, similar: "مواقع مشابهة قد تعجبك"
        },
        de: {
            expertReview: "Überblick", pros: "Vorteile", cons: "Nachteile", conclusion: "Fazit",
            conclusionText: `${localName} ist in unserem Verzeichnis ${localCat} gelistet${ratingSuffix}. Vergleichen Sie es vor dem Besuch mit den ähnlichen Seiten unten und nutzen Sie einen Werbeblocker.`,
            visitSite: `${localName} besuchen &rarr;`, similar: "Ähnliche Seiten, die Ihnen gefallen könnten"
        }
    };
    const l = labels[this.lang] || labels.en;
    const localReviewText = escapeHTML(site[`longReview_${this.lang}`] || site.longReview) || localDesc;

    const hubUrl = CATEGORY_HUBS[category] || null;
    // Jaccard tag similarity — score by tag overlap + category bonus
    const jaccardSimilarity = (tagsA, tagsB) => {
        if (!tagsA || !tagsB || tagsA.length === 0 || tagsB.length === 0) return 0;
        const setA = new Set(tagsA);
        const setB = new Set(tagsB);
        const intersection = [...setA].filter(t => setB.has(t)).length;
        const union = new Set([...tagsA, ...tagsB]).size;
        return union === 0 ? 0 : intersection / union;
    };
    const related = this.sitesData
        .filter(s => s.id !== site.id && isSafeHttpUrl(s.url))
        .map(s => ({
            site: s,
            score: (normalizeCategory(s.category) === category ? 0.5 : 0) +
                   jaccardSimilarity(parseTags(site.tags), parseTags(s.tags))
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map(r => r.site);

    const relatedHTML = related.map(s => {
        const sFavicon = faviconFor(s.url);
        const sid = escapeHTML(encodeURIComponent(s.id));
        return `
            <a href="/site?id=${sid}" class="card" style="display:block; text-decoration:none; color:inherit;">
                <div class="card-header">
                    <img src="${sFavicon}" alt="${escapeHTML(s.name)} logo" class="card-icon" width="32" height="32" loading="lazy">
                    <div>
                        <div class="card-title">${escapeHTML(s.name)}</div>
                        <div class="card-category">${escapeHTML(normalizeCategory(s.category))}</div>
                    </div>
                </div>
                <div class="card-desc" style="font-size:0.85rem; -webkit-line-clamp: 2;">${escapeHTML(s.description)}</div>
            </a>
        `;
    }).join('');

    const isUp = isSiteUp(site);
    const siteId = escapeHTML(encodeURIComponent(site.id));
    const siteUrl = escapeHTML(site.affiliate_url || site.url);
    const stars = rating ? '★'.repeat(Math.floor(rating)) + (rating % 1 >= 0.5 ? '½' : '') : '';
    const pros = Array.isArray(site.pros) ? site.pros : [];
    const cons = Array.isArray(site.cons) ? site.cons : [];
    const statusColor = isUp ? '#22c55e' : '#ef4444';
    const statusText = isUp ? 'Online' : 'Offline';

    const html = `
        <!-- Hero Section -->
        <div class="review-hero">
            <div class="review-hero-bg" style="background-image: url('${faviconUrl}');"></div>
            <div class="review-hero-content">
                <img src="${faviconUrl}" alt="${localName} logo" class="review-hero-icon" width="100" height="100" onerror="this.style.display='none'">
                <div class="review-hero-text">
                    <div class="hero-badges">
                        <span class="hero-badge hero-badge-cat">${localCat}</span>
                        <span class="hero-badge ${isUp ? 'hero-badge-status-online' : 'hero-badge-status-offline'}">
                            <span class="status-dot" style="background:${statusColor}; box-shadow: 0 0 6px ${statusColor};"></span>
                            ${statusText}
                        </span>
                        ${rating ? `<span class="hero-badge hero-badge-rating">${stars} ${rating}/5</span>` : ''}
                    </div>
                    <h1>${localName}</h1>
                    <p class="review-hero-desc">${localDesc || ''}</p>
                </div>
            </div>
        </div>

        <!-- Two-column layout -->
        <div class="review-grid">

            <!-- CENTER: Main review content -->
            <div class="review-main">

                <!-- Quick Verdict / At-a-Glance (High Readability & Search Snippets) -->
                <div class="review-card" style="background: linear-gradient(135deg, rgba(255,42,95,0.08), rgba(121,40,202,0.06)); border-color: rgba(255,42,95,0.3);">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; flex-wrap:wrap; gap:8px;">
                        <h2 style="font-size:1.15rem; margin:0;"><span class="card-icon">⚡</span> Vault Quick Verdict</h2>
                        <span style="background:${isUp ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)'}; color:${statusColor}; font-weight:700; font-size:0.8rem; padding:4px 10px; border-radius:999px; border:1px solid ${statusColor}55;">${isUp ? '● Link online at last check' : '● Link offline at last check'}</span>
                    </div>
                    <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap:12px; margin-bottom:14px; font-size:0.88rem;">
                        <div style="background:var(--bg-surface-elevated); padding:10px 14px; border-radius:8px; border:1px solid var(--border);">
                            <div style="color:var(--text-muted); font-size:0.75rem; text-transform:uppercase; font-weight:700;">Best Suited For</div>
                            <div style="color:#fff; font-weight:600; margin-top:2px;">${localCat} Fans</div>
                        </div>
                        <div style="background:var(--bg-surface-elevated); padding:10px 14px; border-radius:8px; border:1px solid var(--border);">
                            <div style="color:var(--text-muted); font-size:0.75rem; text-transform:uppercase; font-weight:700;">Overall Rating</div>
                            <div style="color:#ffb703; font-weight:700; margin-top:2px;">${rating ? `⭐ ${rating} / 5.0` : 'Not rated yet'}</div>
                        </div>
                        <div style="background:var(--bg-surface-elevated); padding:10px 14px; border-radius:8px; border:1px solid var(--border);">
                            <div style="color:var(--text-muted); font-size:0.75rem; text-transform:uppercase; font-weight:700;">Status &amp; Mirrors</div>
                            <div style="color:${statusColor}; font-weight:600; margin-top:2px;">● ${statusText}</div>
                        </div>
                    </div>
                    ${hubUrl ? `<a href="${hubUrl}" style="display:inline-flex; align-items:center; gap:6px; color:#ff2a5f; font-weight:600; font-size:0.88rem; text-decoration:none; margin-top:4px;">📂 More ${localCat} sites &rarr;</a>` : ''}
                </div>

                <!-- Expert Review Card -->
                <div class="review-card">
                    <h2><span class="card-icon">📝</span> ${l.expertReview}</h2>
                    <p>${localReviewText}</p>
                </div>

                <!-- Pros & Cons Card -->
                ${pros.length || cons.length ? `<div class="review-card">
                    <h2><span class="card-icon">⚖️</span> Pros &amp; Cons</h2>
                    <div class="pros-cons">
                        <div class="pc-box pros">
                            <h3 style="color:#4ade80;">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
                                ${l.pros}
                            </h3>
                            <ul class="pc-list">
                                ${ pros.map(p => `<li><span class="pc-mark" style="color:#4ade80;">✓</span>${escapeHTML(p)}</li>`).join('') }
                            </ul>
                        </div>
                        <div class="pc-box cons">
                            <h3 style="color:#f87171;">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                                ${l.cons}
                            </h3>
                            <ul class="pc-list">
                                ${ cons.map(c => `<li><span class="pc-mark" style="color:#f87171;">✕</span>${escapeHTML(c)}</li>`).join('') }
                            </ul>
                        </div>
                    </div>
                </div>` : ''}

                <!-- Conclusion Card -->
                <div class="review-card">
                    <h2><span class="card-icon">🎯</span> ${l.conclusion}</h2>
                    <p>${l.conclusionText}</p>
                </div>

                <!-- Compare Card -->
                <div class="review-card">
                    <h2><span class="card-icon">⚔️</span> Compare ${localName}</h2>
                    <div class="compare-links">
                        ${related.map(r => `<a href="/compare?site1=${siteId}&amp;site2=${escapeHTML(encodeURIComponent(r.id))}" class="compare-btn" rel="nofollow">${localName} vs ${escapeHTML(r.name)}</a>`).join('')}
                    </div>
                </div>

                <!-- Embed Widget Card -->
                <div class="review-card">
                    <h2><span class="card-icon">🏷️</span> Are you the owner?</h2>
                    <p style="color: var(--text-muted); font-size: 0.9rem; margin-bottom: 14px;">Show off your HentaiVault rating! Copy the embed code below.</p>
                    <textarea readonly style="width: 100%; height: 56px; background: #000; color: #0f0; padding: 10px; border-radius: var(--radius-md); border: 1px solid #333; font-family: monospace; font-size: 11px; resize: none;"><iframe src="https://hentaivault.me/embed?id=${siteId}" width="280" height="76" style="border:none; overflow:hidden;" scrolling="no" frameborder="0" allowTransparency="true" title="HentaiVault Rating Widget"></iframe></textarea>
                    <p style="font-size: 0.8rem; color: var(--text-muted); margin: 12px 0 8px;">Preview:</p>
                    <iframe src="/embed?id=${siteId}" width="280" height="76" style="border:none; overflow:hidden;" scrolling="no" frameborder="0" allowTransparency="true" title="HentaiVault Rating Widget for ${localName}"></iframe>
                </div>

                <!-- Related Sites -->
                <div class="review-card">
                    <h2><span class="card-icon">🔗</span> ${l.similar}</h2>
                    <div class="related-grid" id="relatedGrid">
                        ${relatedHTML}
                    </div>
                </div>

            </div><!-- /review-main -->

            <!-- RIGHT: Sticky Sidebar -->
            <aside class="review-sidebar">

                <!-- Visit Card -->
                <div class="sidebar-card">
                    <a href="${siteUrl}" target="_blank" rel="nofollow noopener noreferrer"
                       class="sidebar-visit-btn btn-visit-tracked"
                       data-id="${escapeHTML(site.id)}" data-outbound="${siteUrl}">
                        ${l.visitSite}
                    </a>
                    <div class="sidebar-stat">
                        <span class="sidebar-stat-label">Status</span>
                        <span class="sidebar-stat-value" style="color:${statusColor};">● ${statusText}</span>
                    </div>
                    <div class="sidebar-stat">
                        <span class="sidebar-stat-label">Category</span>
                        <span class="sidebar-stat-value">${localCat}</span>
                    </div>
                    <div class="sidebar-stat">
                        <span class="sidebar-stat-label">Rating</span>
                        <span class="sidebar-stat-value" style="color:#ff9900;">${rating ? `${stars} ${rating}/5` : 'Not rated'}</span>
                    </div>
                    <div class="sidebar-stat">
                        <span class="sidebar-stat-label">Domain</span>
                        <span class="sidebar-stat-value" style="font-size:0.8rem; word-break:break-all;">${escapeHTML(domain)}</span>
                    </div>
                    <button onclick="copyEmbedBadge(this.dataset.siteId, this.dataset.siteName)" data-site-id="${escapeHTML(site.id)}" data-site-name="${escapeHTML(site.name)}" id="btnEmbedBadge" class="btn-report" style="margin-top:8px; border-color:rgba(56,189,248,0.4); color:#38bdf8; font-weight:600;">🛡️ Embed Badge Code</button>
                    <button onclick="reportDeadLink(this.dataset.siteId)" data-site-id="${escapeHTML(site.id)}" id="btnReportDead" class="btn-report">⚠️ Report Dead Link</button>
                </div>

            </aside>

        </div><!-- /review-grid -->

        <script>
            function copyEmbedBadge(siteId, name) {
                var esc = function (v) { return String(v).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); };
                var code = '<a href="https://hentaivault.me/site?id=' + encodeURIComponent(siteId) + '" target="_blank" title="' + esc(name || 'Site') + ' on HentaiVault"><img src="https://hentaivault.me/assets/favicon.png" width="16" height="16" alt="HentaiVault" /> Featured on HentaiVault</a>';
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(code).then(function() {
                        var btn = document.getElementById('btnEmbedBadge');
                        if (btn) {
                            var oldText = btn.innerHTML;
                            btn.innerHTML = '✅ Badge Code Copied!';
                            setTimeout(function() { btn.innerHTML = oldText; }, 2500);
                        }
                    }).catch(function() {
                        prompt('Copy your site badge embed code:', code);
                    });
                } else {
                    prompt('Copy your site badge embed code:', code);
                }
            }

            function reportDeadLink(id) {
                const btn = document.getElementById('btnReportDead');
                if(btn.innerText.includes('Reporting')) return;
                btn.innerText = 'Reporting...';
                fetch('/api/report-link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({id}) })
                  .then(r => r.json())
                  .then(d => {
                    if (d.success) btn.innerText = '✅ Reported. Thanks!';
                    else btn.innerText = '❌ Site is still alive';
                  })
                  .catch(() => btn.innerText = '⚠️ Error');
            }
        </script>
    `;

    // No FAQPage schema: identical boilerplate Q&A on thousands of pages is exactly
    // the kind of templated markup Google ignores or treats as spam.
    element.setInnerContent(html, { html: true });
  }
}

// Injects a canonical <link> tag pointing to the clean URL.
// NOTE: We deliberately do NOT add ?lang= hreflang alternates here because:
// - The lang variants are client-side UI state, not separate indexable pages
// - Adding them as hreflang links caused Google to crawl them as separate pages
//   which triggered "Page with redirect" and "Crawled not indexed" GSC errors.

class EmbedHandler {
  constructor(site) {
    this.site = site;
  }
  element(element) {
    const rating = Math.max(0, Math.min(5, Number(this.site.rating) || 0));
    const fullStars = Math.floor(rating);
    const halfStar = (rating % 1) >= 0.5;
    const starsText = '★'.repeat(fullStars) + (halfStar ? '½' : '') + '☆'.repeat(5 - fullStars - (halfStar ? 1 : 0));
    const data = {
      icon: faviconFor(this.site.url),
      title: String(this.site.name || ''),
      rating: starsText,
      link: `https://hentaivault.me/site?id=${encodeURIComponent(this.site.id)}`,
    };
    // JSON.stringify + '<' escaping keeps site-controlled strings inert inside the script.
    element.append(`<script>(function (d) {
      document.getElementById('embed-icon').src = d.icon;
      document.getElementById('embed-title').innerText = d.title;
      document.getElementById('embed-rating').innerText = d.rating;
      document.getElementById('embed-link').href = d.link;
    })(${JSON.stringify(data).replace(/</g, '\\u003c')});</script>`, { html: true });
  }
}
class CanonicalInjector {
  constructor(canonicalUrl, lang) {
    this.canonicalUrl = canonicalUrl;
    this.lang = lang;
  }
  element(element) {
    element.prepend(`<link rel="canonical" href="${this.canonicalUrl}">`, { html: true });
  }
}

// ── Edge cache ───────────────────────────────────────────────────────────────
// D1 bills (and on the free plan caps, at 5M a day) every row a query reads, and
// the read-heavy routes scan the whole sites table. Their results are kept in
// Cloudflare's cache (per data centre), so a crawl or a traffic spike does not
// turn every request into full-table reads.
const EDGE_CACHE_SECONDS = {
  '/api/sites': 300, '/api/site-count': 600, '/api/site': 600, '/api/alternatives': 900,
  '/api/site-of-the-day': 3600, '/api/site-of-the-week': 3600, '/api/trending': 600,
  '/sitemap.xml': 3600, '/rss.xml': 1800,
};
// The shuffled homepage order comes in this many variants (picked by the session's
// seed) instead of one per session, so shuffled pages are cacheable too.
const SHUFFLE_VARIANTS = 16;
const shuffleBucket = raw => Math.abs(parseInt(raw || '0', 10) || 0) % SHUFFLE_VARIANTS;

function edgeCacheKey(url) {
  const key = new URL(url);
  key.hash = '';
  if (key.searchParams.has('seed')) key.searchParams.set('seed', String(shuffleBucket(key.searchParams.get('seed'))));
  key.searchParams.sort();
  return new Request(key.toString(), { method: 'GET' });
}

const edgeCache = () => (typeof caches !== 'undefined' ? caches.default : null);

/** A JSON value computed at most once per ttl seconds per data centre. */
async function edgeCachedJson(ctx, name, ttl, compute) {
  const cache = edgeCache();
  const key = new Request(`https://hentaivault.me/__edge-cache/${name}`);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit.json();
  }
  const value = await compute();
  if (cache) {
    const res = new Response(JSON.stringify(value), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttl}` },
    });
    ctx.waitUntil(cache.put(key, res).catch(() => {}));
  }
  return value;
}

// Listings for server-rendered internal links (homepage, category hubs, guides).
// Only rows rated MIN_INDEXABLE_RATING or higher can be linked, so the query reads
// just those (idx_rating); the result is cached at the edge for an hour and in
// the isolate for ten minutes.
const LINK_SNAPSHOT_TTL_MS = 10 * 60 * 1000;
let linkSnapshot = { at: 0, sites: null, nameIndex: null };

async function getLinkSnapshot(env, ctx) {
  if (linkSnapshot.sites && Date.now() - linkSnapshot.at < LINK_SNAPSHOT_TTL_MS) return linkSnapshot;
  const rows = await edgeCachedJson(ctx, 'link-snapshot-v1', 3600, async () =>
    (await env.hv_directory.prepare(
      `SELECT ${LINK_COLUMNS} FROM sites WHERE rating >= ${MIN_INDEXABLE_RATING} AND ${NOT_PROHIBITED_SQL}`
    ).all()).results);
  const sites = rows.filter(s => isListingVisible(s) && isSafeHttpUrl(s.url));
  linkSnapshot = { at: Date.now(), sites, nameIndex: buildNameIndex(sites) };
  return linkSnapshot;
}

// Category hub: keeps the hand-written cards that still point at a live listing,
// drops the rest, then appends the best-rated indexable listings up to HUB_LINKS.
class HubCardFilter {
  constructor(visibleIds, kept) { this.visibleIds = visibleIds; this.kept = kept; }
  element(el) {
    const id = new URL(el.getAttribute('href') || '', 'https://hentaivault.me').searchParams.get('id');
    if (id && this.visibleIds.has(id)) this.kept.add(id);
    else el.remove();
  }
}

class HubGridAppender {
  constructor(snapshot, hub, kept) { this.snapshot = snapshot; this.hub = hub; this.kept = kept; }
  element(el) {
    el.onEndTag(end => {
      const extra = topForHub(this.snapshot.sites, this.hub, Math.max(HUB_LINKS - this.kept.size, 0), this.kept);
      end.before(renderHubCards(extra), { html: true });
    });
  }
}

class HomeTopSites {
  constructor(html) { this.html = html; }
  element(el) {
    if (this.html) el.setInnerContent(this.html, { html: true });
    else el.remove();
  }
}

// Guide: collects the article's headings, then lists the reviewed sites they name.
class GuideHeadingCollector {
  constructor(headings) { this.headings = headings; }
  element() { this.headings.push(''); }
  text(t) { if (this.headings.length) this.headings[this.headings.length - 1] += t.text; }
}

class GuideLinksAppender {
  constructor(snapshot, headings) { this.snapshot = snapshot; this.headings = headings; }
  element(el) {
    el.onEndTag(end => {
      const html = renderGuideLinks(this.headings, this.snapshot.nameIndex);
      if (html) end.before(html, { html: true });
    });
  }
}

class CanonicalRemover {
  element(element) {
    element.remove();
  }
}

class OutHandler {
  constructor(site) {
    this.site = site;
  }
  element(element) {
    element.setInnerContent(this.site.url);
  }
}

class CompareHeadHandler {
  constructor(site1, site2, canonicalUrl) {
    this.site1 = site1;
    this.site2 = site2;
    this.canonicalUrl = canonicalUrl;
  }
  element(element) {
    const title = `${this.site1.name} vs ${this.site2.name} | HentaiVault`;
    const desc = `Compare ${this.site1.name} and ${this.site2.name}: ratings, pros and cons side by side on HentaiVault.`;
    element.append([
      `<link rel="canonical" href="${escapeHTML(this.canonicalUrl)}">`,
      `<meta name="robots" content="noindex, follow">`,
      `<meta name="description" content="${escapeHTML(desc)}">`,
      `<meta property="og:title" content="${escapeHTML(title)}">`,
      `<meta property="og:description" content="${escapeHTML(desc)}">`,
      `<meta property="og:url" content="${escapeHTML(this.canonicalUrl)}">`,
    ].join('\n'), { html: true });
  }
}

class CompareBodyHandler {
  constructor(site1, site2) {
    this.site1 = site1;
    this.site2 = site2;
  }
  column(site) {
    const rating = Number(site.rating) > 0 ? `${Number(site.rating)} / 5` : 'Not rated';
    const id = escapeHTML(encodeURIComponent(site.id));
    return `
          <div class="review-content" style="text-align: center;">
              <img src="${faviconFor(site.url)}" alt="${escapeHTML(site.name)}" class="review-icon" style="margin: 0 auto 20px;" width="64" height="64">
              <h2>${escapeHTML(site.name)}</h2>
              <div class="rating" style="margin-bottom: 20px;">Rating: ${rating}</div>
              <p style="text-align: left;">${escapeHTML(site.description)}</p>
              ${Array.isArray(site.pros) && site.pros.length ? `
              <div class="pros-cons" style="grid-template-columns: 1fr; gap: 15px;">
                  <div class="pc-box pros" style="text-align: left;">
                      <h3>Pros</h3>
                      <ul class="pc-list">${site.pros.map(p => `<li>${escapeHTML(p)}</li>`).join('')}</ul>
                  </div>
              </div>` : ''}
              <div style="margin-top: 30px;">
                  <a href="/site?id=${id}" class="btn-visit" style="background:var(--bg-elevated); color:var(--text-main); border:1px solid var(--border); margin-right: 10px;">Full Review</a>
                  <a href="${escapeHTML(site.url)}" target="_blank" rel="nofollow noopener noreferrer" class="btn-visit btn-visit-tracked" data-id="${escapeHTML(site.id)}">Visit Site</a>
              </div>
          </div>`;
  }
  element(element) {
    const html = `
      <div class="review-header" style="justify-content: center; text-align: center; flex-direction: column;">
          <h1 style="margin-bottom: 20px;">${escapeHTML(this.site1.name)} vs ${escapeHTML(this.site2.name)}</h1>
          <div class="review-badge">${escapeHTML(normalizeCategory(this.site1.category))}</div>
      </div>
      <div class="compare-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 30px; margin-top: 40px;">
          ${this.column(this.site1)}
          ${this.column(this.site2)}
      </div>
    `;
    element.setInnerContent(html, { html: true });
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const ttl = request.method === 'GET' ? EDGE_CACHE_SECONDS[url.pathname] : undefined;
      const cache = ttl && edgeCache();
      if (!cache) return await handleRequest(request, env, ctx);

      const key = edgeCacheKey(url);
      const hit = await cache.match(key);
      if (hit) return hit;
      const res = await handleRequest(request, env, ctx);
      if (res.status === 200 && !res.headers.has('Set-Cookie')) {
        const copy = new Response(res.clone().body, res);
        copy.headers.set('Cache-Control', `public, max-age=${ttl}`);
        ctx.waitUntil(cache.put(key, copy).catch(() => {}));
      }
      return res;
    } catch (err) {
      console.error('Unhandled worker error:', err);
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      });
    }
  },

  async scheduled(event, env, ctx) {
    return handleScheduled(event, env, ctx);
  }
};

// Security headers added to all first-party HTML responses (not /embed, which
// must stay frameable by other sites).
// Ads (Adsterra/HighPerformanceFormat rotate their script and frame hosts) and
// GA4 need broad https: sources; a narrower list silently blocks them.
const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https:",
    "style-src 'self' 'unsafe-inline' https:",
    "font-src 'self' data: https:",
    "img-src 'self' data: blob: https: http:",
    "media-src 'self' https:",
    "frame-src https:",
    "connect-src 'self' https:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; '),
};

function withHeaders(response, extra = {}) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries({ ...SECURITY_HEADERS, ...extra })) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function addSecurityHeaders(response) {
  return withHeaders(response);
}

// Serves the static 404 page with the given status (404 or 410 for removed listings).
async function notFoundPage(env, url, status = 404) {
  // Assets use html_handling "auto-trailing-slash": /404 serves 404.html directly,
  // while /404.html would answer with a 307 redirect.
  const page = await env.ASSETS.fetch(new Request(url.origin + '/404'));
  const body = page.ok ? page.body : 'Not found';
  return withHeaders(new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'X-Robots-Tag': 'noindex' },
  }));
}

async function handleRequest(request, env, ctx) {
    const url = new URL(request.url);

    // ── Canonical host: www → apex (one indexable host) ─────────────────────────
    if (url.hostname === 'www.hentaivault.me') {
      url.hostname = 'hentaivault.me';
      url.protocol = 'https:';
      return new Response(null, {
        status: 301,
        headers: { 'Location': url.toString(), 'Cache-Control': 'public, max-age=86400' }
      });
    }

    // ── Force HTTPS redirect (fixes HTTP duplicate pages in GSC & Bing) ────────────
    if (url.protocol === 'http:') {
      const httpsUrl = new URL(request.url);
      httpsUrl.protocol = 'https:';
      return new Response(null, {
        status: 301,
        headers: {
          'Location': httpsUrl.toString(),
          'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
          'Cache-Control': 'public, max-age=31536000'
        }
      });
    }

    // Detect Geo Lang
    const cookieHeader = request.headers.get('Cookie') || '';
    const langCookieMatch = cookieHeader.match(/hv_lang=([a-z]{2})/);
    const cookieLang = langCookieMatch ? langCookieMatch[1] : null;

    let detectedLang = 'en';
    const country = request.cf ? request.cf.country : null;
    if (country === 'BR') detectedLang = 'pt';
    else if (country === 'IN') detectedLang = 'hi';
    else if (country === 'MA') detectedLang = 'ar';
    else if (['DE', 'AT', 'CH'].includes(country)) detectedLang = 'de';
    else if (country === 'FR') detectedLang = 'fr';
    else if (['ES', 'MX', 'AR', 'CO', 'CL', 'PE'].includes(country)) detectedLang = 'es';
    else if (country === 'JP') detectedLang = 'jp';

    const requestedLang = url.searchParams.get('lang') || cookieLang;
    const effectiveLang = SUPPORTED_LANGS.includes(requestedLang) ? requestedLang : detectedLang;

    // Geo-Routing/Redirect removed for SEO compliance.
    // The client-side i18n.js script handles language rendering client-side.

    // ── Route: IndexNow key verification ────────────────────────────────────
    if (env.INDEXNOW_KEY && url.pathname === `/${env.INDEXNOW_KEY}.txt`) {
      return new Response(env.INDEXNOW_KEY, {
        headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=86400' },
      });
    }

    // ── Route: Sitemap — one file generated from live D1 data ──────────────
    // The old split sitemap URLs redirect here so existing references keep working.
    if (url.pathname === '/sitemap-index.xml' || url.pathname === '/sitemap-pages.xml' || url.pathname === '/sitemap-sites.xml') {
      return new Response(null, {
        status: 301,
        headers: { 'Location': 'https://hentaivault.me/sitemap.xml', 'Cache-Control': 'public, max-age=86400' },
      });
    }

    if (url.pathname === '/sitemap.xml') {
      let urls = SITEMAP_STATIC_PAGES.map(p => `  <url>\n    <loc>https://hentaivault.me${p}</loc>\n  </url>\n`).join('');
      if (env.hv_directory) {
        try {
          const rows = await env.hv_directory.prepare(
            `SELECT id, url, category, rating, added_at,
                    json_extract(data_json, '$.name') AS name,
                    json_extract(data_json, '$.description') AS description,
                    json_extract(data_json, '$.isUp') AS isUp,
                    json_extract(data_json, '$.isDeadFlagged') AS isDeadFlagged,
                    json_extract(data_json, '$.tags') AS tags,
                    json_extract(data_json, '$.releasedAt') AS releasedAt
             FROM sites ORDER BY rating DESC, added_at DESC`
          ).all();
          for (const row of rows.results) {
            if (!isIndexable(row)) continue;
            const lastmod = (row.added_at && row.added_at.length >= 10) ? `\n    <lastmod>${row.added_at.slice(0, 10)}</lastmod>` : '';
            urls += `  <url>\n    <loc>https://hentaivault.me/site?id=${escapeHTML(encodeURIComponent(row.id))}</loc>${lastmod}\n  </url>\n`;
          }
        } catch (err) {
          console.error('Sitemap D1 error:', err);
          return new Response('Sitemap temporarily unavailable', { status: 503, headers: { 'Retry-After': '600' } });
        }
      }
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}</urlset>`;
      return new Response(xml, {
        status: 200,
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        }
      });
    }

    // ── Route: /api/site-count ───────────────────────────────────────────────
    if (url.pathname === '/api/site-count') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
      }
      if (!env.hv_directory) return jsonError('Database not configured', 500);
      try {
        const result = await env.hv_directory.prepare('SELECT COUNT(*) as count FROM sites').first();
        return new Response(
          JSON.stringify({ count: result.count }),
          { status: 200, headers: { ...CORS, 'Cache-Control': 'public, max-age=60' } }
        );
      } catch (err) {
        return jsonError('Database error', 500);
      }
    }

    // ── Route: /api/status ──────────────────────────────────────────────────────
    if (url.pathname === '/api/status') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
      }
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) return jsonError('Missing url', 400);

      try {
        const targetUrlObj = new URL(targetUrl);
        if (targetUrlObj.protocol !== 'http:' && targetUrlObj.protocol !== 'https:') {
          return jsonError('Invalid protocol', 400);
        }
        const hostname = targetUrlObj.hostname.toLowerCase();
        // Only public DNS names: no IP literals, no single-label or internal hosts.
        if (!hostname.includes('.') || /^[\d.]+$/.test(hostname) || hostname.includes(':') ||
            /(^|\.)(localhost|local|internal|lan|home|corp)$/.test(hostname) || targetUrlObj.username || targetUrlObj.password) {
          return jsonError('Invalid host', 400);
        }
        const start = Date.now();
        const res = await fetch(targetUrl, { 
          method: 'HEAD', 
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
          signal: AbortSignal.timeout(3500)
        });
        
        const latency = Date.now() - start;
        // Consider anything < 500 as "up", some sites return 403 for bots which means their server is UP
        const up = res.status >= 200 && res.status < 500 && res.status !== 404;
        
        return new Response(
          JSON.stringify({ up, latency, status: res.status }),
          { status: 200, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' } }
        );
      } catch (err) {
        return new Response(
          JSON.stringify({ up: false, latency: 0, status: 0 }),
          { status: 200, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=120' } }
        );
      }
    }

    // ── Route: /api/site ───────────────────────────────────────────────────────
    if (url.pathname === '/api/site') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
      }
      if (!env.hv_directory) return jsonError('Database not configured', 500);
      const id = url.searchParams.get('id');
      if (!id) return jsonError('Missing site id', 400);
      try {
        const result = await env.hv_directory.prepare(`SELECT data_json FROM sites WHERE id = ? AND ${NOT_PROHIBITED_SQL}`).bind(id).first();
        if (!result || !visibleSites([result]).length) return jsonError('Site not found', 404);
        return new Response(
          result.data_json,
          { status: 200, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' } }
        );
      } catch (err) {
        return jsonError('Database error', 500);
      }
    }

    // ── Route: /api/alternatives ────────────────────────────────────────────────
    if (url.pathname === '/api/alternatives') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
      }
      if (!env.hv_directory) return jsonError('Database not configured', 500);
      const id = url.searchParams.get('id');
      if (!id) return jsonError('Missing site id', 400);
      try {
        const target = await env.hv_directory.prepare('SELECT category FROM sites WHERE id = ?').bind(id).first();
        if (!target) return jsonError('Site not found', 404);
        
        const result = await env.hv_directory.prepare(`
          SELECT data_json
          FROM sites
          WHERE category = ? AND id != ? AND ${NOT_PROHIBITED_SQL}
          ORDER BY rating DESC, added_at DESC
          LIMIT 12
        `).bind(target.category, id).all();
        
        const sites = visibleSites(result.results);
        return new Response(
          JSON.stringify({ sites }),
          { status: 200, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' } }
        );
      } catch (err) {
        return jsonError('Database error', 500);
      }
    }

    // ── Route: /api/subscribe-digest ───────────────────────────────────────
    if (url.pathname === '/api/subscribe-digest') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
      }
      if (request.method !== 'POST') return jsonError('Method not allowed', 405);
      try {
        if (await checkRateLimit(request.headers.get('cf-connecting-ip'), env)) {
          return jsonError('Too many requests. Please try again later.', 429);
        }
        const body = await request.json();
        const email = String(body.email || '').trim().toLowerCase();
        if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonError('Invalid email', 400);
        // Store in KV using email as key, timestamped value
        if (env.PUSH_SUBSCRIBERS) {
          await env.PUSH_SUBSCRIBERS.put(`digest:${email}`, JSON.stringify({ email, subscribed_at: new Date().toISOString() }));
        }
        return new Response(JSON.stringify({ success: true }), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
      } catch (err) {
        return jsonError('Subscription failed', 500);
      }
    }

    // ── Route: /api/reviews ────────────────────────────────────────────────
    if (url.pathname === '/api/reviews') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
      }
      if (!env.hv_directory) return jsonError('Database not configured', 500);
      
      const site_id = url.searchParams.get('id');
      if (!site_id) return jsonError('Missing site id', 400);

      if (request.method === 'GET') {
        try {
          const result = await env.hv_directory.prepare('SELECT user_name, rating, comment, created_at FROM reviews WHERE site_id = ? ORDER BY created_at DESC LIMIT 50').bind(site_id).all();
          return new Response(
            JSON.stringify({ reviews: result.results }),
            { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } }
          );
        } catch (err) {
          return jsonError('Database error', 500);
        }
      }

      if (request.method === 'POST') {
        try {
          const ip = request.headers.get('cf-connecting-ip');
          if (await checkRateLimit(ip, env)) {
            return jsonError('Too many submissions. Please try again later.', 429);
          }

          const body = await request.json();
          const rating = parseInt(body.rating, 10);
          const comment = String(body.comment || '').trim();
          const userName = String(body.user_name || '').trim().slice(0, 40) || 'Anonymous';
          if (!(rating >= 1 && rating <= 5) || comment.length < 3) return jsonError('Missing required fields', 400);
          if (comment.length > 2000) return jsonError('Review is too long (max 2000 characters).', 400);

          // Reviews are published immediately, so no links and nothing on the blocklist.
          if (/https?:\/\/|www\.|\.(com|net|org|xxx|io|me|to)\b/i.test(comment + ' ' + userName)) {
            return jsonError('Links are not allowed in reviews.', 400);
          }
          if (!isMinorSafe(comment, userName)) return jsonError('Review rejected.', 400);

          const human = await verifyHuman(body, ip, env);
          if (!human.ok) return jsonError(human.error, 400);

          const reviewVerdict = await decide(env, { user_name: userName, comment, rating }, REVIEW_QUESTIONS);
          if (reviewVerdict?.answers?.verdict?.choice && reviewVerdict.answers.verdict.choice !== 'ok') {
            return jsonError('Review rejected.', 400);
          }

          const siteExists = await env.hv_directory.prepare('SELECT 1 FROM sites WHERE id = ?').bind(site_id).first();
          if (!siteExists) return jsonError('Site not found', 404);

          await env.hv_directory.prepare(
            'INSERT INTO reviews (site_id, user_name, rating, comment) VALUES (?, ?, ?, ?)'
          ).bind(site_id, userName, rating, comment).run();

          return new Response(
            JSON.stringify({ success: true }),
            { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } }
          );
        } catch (err) {
          return jsonError('Failed to submit review', 500);
        }
      }
      return jsonError('Method not allowed', 405);
    }

    // ── Route: /api/site-of-the-day ─────────────────────────────────────────
    if (url.pathname === '/api/site-of-the-day' || url.pathname === '/api/site-of-the-week') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
      }
      if (!env.hv_directory) return jsonError('Database not configured', 500);

      try {
        const now = new Date();
        const dayStr = now.toISOString().split('T')[0];
        
        const topSites = await env.hv_directory.prepare(
          `SELECT data_json FROM sites WHERE ${NOT_PROHIBITED_SQL} AND COALESCE(json_extract(data_json, '$.isUp'), 1) != 0 ORDER BY rating DESC LIMIT 50`
        ).all();
        const candidates = visibleSites(topSites.results);
        if (candidates.length === 0) return jsonError('No sites found', 404);

        let hash = 0;
        for (let i = 0; i < dayStr.length; i++) hash += dayStr.charCodeAt(i);
        
        const selectedIdx = hash % candidates.length;
        const site = candidates[selectedIdx];
        
        return new Response(JSON.stringify({ site }), {
          headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }
        });
      } catch (e) {
        return jsonError('Error fetching site', 500);
      }
    }

    // ── Route: /api/directory-export-v2-full.json (Honeypot) ────────────────
    if (url.pathname === '/api/directory-export-v2-full.json') {
      // Rate-limit the honeypot to prevent bandwidth abuse from parallel scrapers
      const honeypotIp = request.headers.get('cf-connecting-ip');
      if (await checkRateLimit(honeypotIp, env)) {
        return new Response(null, { status: 429 });
      }
      // Scraper Honeypot: Return slow-streamed fake data (tarpit)
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode('{"data":[\n'));
          let i = 0;
          function pushFake() {
            if (i > 5000) { controller.close(); return; } // Cap at 5000 to prevent Cloudflare Worker timeout eviction
            const fakeSite = { id: `site_${Math.random().toString(36).substring(7)}`, name: `Hentai${Math.random().toString(36).substring(7)}`, url: `https://fake-${Math.random().toString(36).substring(7)}.com`, rating: (Math.random() * 5).toFixed(1) };
            controller.enqueue(new TextEncoder().encode(JSON.stringify(fakeSite) + ',\n'));
            i++;
            setTimeout(pushFake, 5); // Stream slowly to tarpit
          }
          pushFake();
        }
      });
      return new Response(stream, { headers: { 'Content-Type': 'application/json' } });
    }

    // ── Route: /api/sites ────────────────────────────────────────────────────
    if (url.pathname === '/api/sites') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
      }
      if (!env.hv_directory) return jsonError('Database not configured', 500);
      try {
        const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 24));
        const offset = (page - 1) * limit;

        let query = 'SELECT data_json FROM sites';
        let params = [];
        let conditions = [NOT_PROHIBITED_SQL];

        const q = url.searchParams.get('q');
        if (q) {
          // Use FTS5 virtual table for lightning-fast full text search
          conditions.push('rowid IN (SELECT rowid FROM sites_fts WHERE sites_fts MATCH ?)');
          
          // Basic sanitize for FTS MATCH syntax to prevent syntax errors
          const sanitizedQ = q.replace(/["*()]/g, ' ').trim().slice(0, 100);
          params.push(`"${sanitizedQ}"*`);
        }
        
        const category = url.searchParams.get('category');
        if (category) {
          const variants = categoryVariants(category);
          conditions.push(`category IN (${variants.map(() => '?').join(',')})`);
          params.push(...variants);
        }

        const tagsStr = url.searchParams.get('tags');
        if (tagsStr) {
          const tagsArray = tagsStr.split(',').map(t => t.trim().replace(/[%_"]/g, '')).filter(Boolean).slice(0, 10);
          // Use AND for advanced filtering
          const tagConditions = tagsArray.map(tag => {
            params.push(`%"${tag}"%`);
            return 'data_json LIKE ?';
          });
          conditions.push(`(${tagConditions.join(' AND ')})`);
        }
        
        // WHERE clause shared by count + data query (no exclude needed)
        const whereClause = ' WHERE ' + conditions.join(' AND ');
        const countResult = await env.hv_directory.prepare(
          'SELECT COUNT(*) as count FROM sites' + whereClause
        ).bind(...params).first();
        const total = countResult ? countResult.count : 0;

        query += whereClause;

        const sort = url.searchParams.get('sort') || 'random';
        if (q && sort === 'random') {
          // Searches keep FTS match order (the IN subquery can't expose FTS rank).
        } else if (sort === 'rating') {
          query += ' ORDER BY rating DESC';
        } else if (sort === 'popular') {
          query += ' ORDER BY clicks DESC, rating DESC';
        } else if (sort === 'newest') {
          query += ' ORDER BY added_at DESC';
        } else if (sort === 'alphabetical' || sort === 'alpha') {
          // There is no name column; the name lives in data_json.
          query += " ORDER BY json_extract(data_json, '$.name') COLLATE NOCASE ASC";
        } else {
          // Seeded deterministic random: stable per-session shuffle, OFFSET-safe
          // seed is a positive integer passed by the client once per session
          const seed = Math.floor(2147483629 / (shuffleBucket(url.searchParams.get('seed')) + 2));
          query += ` ORDER BY (rowid * ${seed}) % 1000000007`;
        }
        
        query += ' LIMIT ? OFFSET ?';
        params.push(limit, offset);
        
        const result = await env.hv_directory.prepare(query).bind(...params).all();
        const sites = visibleSites(result.results);
        
        return new Response(
          JSON.stringify({ total, sites }),
          { status: 200, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' } }
        );
      } catch (err) {
        console.error("Error fetching sites from D1:", err);
        return jsonError('Database error', 500);
      }
    }

    // ── Route: /rss.xml ─────────────────────────────────────────────────────
    if (url.pathname === '/rss.xml') {
      if (!env.hv_directory) return new Response('DB Error', { status: 500 });
      try {
        const result = await env.hv_directory.prepare(`SELECT id, data_json, added_at FROM sites WHERE ${NOT_PROHIBITED_SQL} ORDER BY added_at DESC LIMIT 50`).all();
        const cdata = (v) => String(v || '').replace(/]]>/g, ']]]]><![CDATA[>');
        let items = '';
        for (const r of result.results) {
          const site = JSON.parse(r.data_json);
          if (!isListingVisible(site)) continue;
          const link = `https://hentaivault.me/site?id=${escapeHTML(encodeURIComponent(site.id))}`;
          const added = new Date(r.added_at);
          const pubDate = isNaN(added) ? '' : `<pubDate>${added.toUTCString()}</pubDate>`;
          items += `
            <item>
              <title><![CDATA[${cdata(site.name)} (${cdata(normalizeCategory(site.category))})]]></title>
              <link>${link}</link>
              <guid>${link}</guid>
              ${pubDate}
              <description><![CDATA[${cdata(sanitize(site.description || ''))}]]></description>
            </item>
          `;
        }
        const rss = `<?xml version="1.0" encoding="UTF-8" ?>
          <rss version="2.0">
            <channel>
              <title>HentaiVault - New Sites</title>
              <link>https://hentaivault.me</link>
              <description>The latest adult sites and directories added to HentaiVault.</description>
              <language>en-us</language>
              ${items}
            </channel>
          </rss>`;
        return new Response(rss, { headers: { 'Content-Type': 'application/rss+xml', 'Cache-Control': 'public, max-age=3600' } });
      } catch (e) {
        return new Response('Error generating RSS', { status: 500 });
      }
    }

    // ── Route: /api/report-link ──────────────────────────────────────────────
    if (url.pathname === '/api/report-link') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (request.method !== 'POST') return jsonError('Method not allowed', 405);
      if (!env.hv_directory) return jsonError('DB not configured', 500);
      try {
        if (await checkRateLimit(request.headers.get('cf-connecting-ip'), env)) return jsonError('Too many requests', 429);
        const body = await request.json();
        if (!body.id || typeof body.id !== 'string') return jsonError('Missing ID', 400);

        const row = await env.hv_directory.prepare('SELECT url FROM sites WHERE id = ?').bind(body.id).first();
        if (!row) return jsonError('Not found', 404);
        
        let isDead = false;
        try {
          const res = await fetch(row.url, { 
            method: 'HEAD', 
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0' },
            signal: AbortSignal.timeout(5000) 
          });
          if (res.status === 404 || res.status >= 500) isDead = true;
        } catch (e) {
          isDead = true;
        }
        
        if (isDead) {
          // Changed during audit: DO NOT permanently delete sites via anonymous API.
          // In a real system, we would flag this for manual review.
          // For now, simply return success so the frontend stops pinging it.
          console.log(`[REPORT LINK] Flagged site ${body.id} as dead. Needs manual review.`);
          return new Response(JSON.stringify({ success: true, removed: false, flagged: true }), { headers: CORS });
        } else {
          return new Response(JSON.stringify({ success: false, removed: false, msg: 'Site is responding.' }), { headers: CORS });
        }
      } catch (e) {
        return jsonError('Error reporting', 500);
      }
    }

    // ── Route: /api/vault/sync ──────────────────────────────────────────────
    if (url.pathname === '/api/vault/sync') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (!env.PUSH_SUBSCRIBERS) return jsonError('KV not configured', 500);
      
      const code = url.searchParams.get('code') || '';
      if (!/^[A-Za-z0-9]{8,32}$/.test(code)) return jsonError('Invalid code', 400);
      const key = `vault_sync:${code}`;

      if (request.method === 'GET') {
        const data = await env.PUSH_SUBSCRIBERS.get(key);
        return new Response(data || '[]', { headers: { ...CORS, 'Content-Type': 'application/json' } });
      } 
      else if (request.method === 'POST') {
        const ip = request.headers.get('CF-Connecting-IP');
        if (await checkRateLimit(ip, env)) return jsonError('Rate limit exceeded', 429);
        
        const body = await request.text();
        if (body.length > 20000) return jsonError('Payload too large', 413);
        let favorites;
        try { favorites = JSON.parse(body); } catch { return jsonError('Invalid payload', 400); }
        if (!Array.isArray(favorites) || favorites.some(f => typeof f !== 'string' || f.length > 100)) {
          return jsonError('Invalid payload', 400);
        }

        await env.PUSH_SUBSCRIBERS.put(key, JSON.stringify(favorites), { expirationTtl: 60 * 60 * 24 * 365 });
        return new Response(JSON.stringify({ success: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
      }
      return jsonError('Method not allowed', 405);
    }

    // ── Route: /api/click ───────────────────────────────────────────────────
    if (url.pathname === '/api/click') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (request.method !== 'POST') return jsonError('Method not allowed', 405);
      if (!env.hv_directory) return jsonError('DB not configured', 500);
      try {
        const body = await request.json();
        if (!body.id || typeof body.id !== 'string' || body.id.length > 100) return jsonError('Missing ID', 400);
        // (the amazon_ads table referenced by older code does not exist in D1)
        await env.hv_directory.prepare('UPDATE sites SET clicks = COALESCE(clicks, 0) + 1 WHERE id = ?').bind(body.id).run();

        return new Response(JSON.stringify({ success: true }), { headers: CORS });
      } catch (e) {
        return jsonError('Error updating click', 500);
      }
    }

    // ── Route: /api/trending ────────────────────────────────────────────────
    if (url.pathname === '/api/trending') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (!env.hv_directory) return jsonError('DB not configured', 500);
      try {
        const result = await env.hv_directory.prepare(`SELECT data_json FROM sites WHERE ${NOT_PROHIBITED_SQL} ORDER BY clicks DESC LIMIT 3`).all();
        const sites = visibleSites(result.results).map(s => {
            s.isTrending = true;
            return s;
        });
        return new Response(JSON.stringify({ sites }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
      } catch (e) {
        return jsonError('Error fetching trending', 500);
      }
    }

    // ── Route: /api/recommend ───────────────────────────────────────────────
    if (url.pathname === '/api/recommend') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (!env.hv_directory) return jsonError('DB not configured', 500);
      try {
        const likes = url.searchParams.get('likes');
        if (!likes) return new Response(JSON.stringify({ sites: [] }), { headers: CORS });
        const likeIds = [...new Set(likes.split(',').map(s => s.trim()).filter(Boolean))].slice(0, 40);
        if (likeIds.length === 0) return new Response(JSON.stringify({ sites: [] }), { headers: CORS });
        
        const placeholders = likeIds.map(() => '?').join(',');
        const queryLiked = `SELECT data_json FROM sites WHERE id IN (${placeholders})`;
        const likedRes = await env.hv_directory.prepare(queryLiked).bind(...likeIds).all();
        
        const tagFreq = {};
        for (const r of likedRes.results) {
            const s = JSON.parse(r.data_json);
            if (s.tags) s.tags.forEach(t => { tagFreq[t] = (tagFreq[t] || 0) + 1 });
        }
        
        const sortedTags = Object.entries(tagFreq).sort((a,b) => b[1]-a[1]).map(x => x[0]).slice(0, 2);
        
        if (sortedTags.length === 0) return new Response(JSON.stringify({ sites: [] }), { headers: CORS });
        
        const tagConditions = sortedTags.map(tag => `data_json LIKE ?`).join(' AND ');
        const params = sortedTags.map(t => `%"${String(t).replace(/[%_]/g, '')}"%`);
        params.push(...likeIds);
        
        const queryRec = `SELECT data_json FROM sites WHERE (${tagConditions}) AND id NOT IN (${placeholders}) AND ${NOT_PROHIBITED_SQL} ORDER BY rating DESC LIMIT 5`;
        const recRes = await env.hv_directory.prepare(queryRec).bind(...params).all();
        
        const sites = visibleSites(recRes.results);
        return new Response(JSON.stringify({ sites }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
      } catch (e) {
        return jsonError('Error fetching recommendations', 500);
      }
    }



    // ── Route: /api/random ──────────────────────────────────────────────────
    if (url.pathname === '/api/random') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
      }
      if (!env.hv_directory) return jsonError('Database not configured', 500);
      try {
        const result = await env.hv_directory.prepare(
          `SELECT id, json_extract(data_json, '$.name') AS name, url, category FROM sites WHERE ${NOT_PROHIBITED_SQL} ORDER BY RANDOM() LIMIT 1`
        ).first();
        if (!result || !isMinorSafe(result.url, result.name)) return jsonError('No sites found', 404);
        return new Response(
          JSON.stringify(result),
          { status: 200, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' } }
        );
      } catch (err) {
        return jsonError('Database error', 500);
      }
    }

    // ── Route: /api/submit ──────────────────────────────────────────────────
    if (url.pathname === '/api/submit') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
      }
      if (request.method === 'POST') {
        return handleSubmit(request, env, ctx);
      }
      return jsonError('Method not allowed.', 405);
    }

    // ── Route: /api/push-subscribe ──────────────────────────────────────────
    if (url.pathname === '/api/push-subscribe') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
      }
      if (request.method === 'POST') {
        if (!env.PUSH_SUBSCRIBERS) return jsonError('Push KV namespace not configured.', 500);
        try {
          const raw = await request.text();
          if (raw.length > 4000) return jsonError('Payload too large', 413);
          const subscription = JSON.parse(raw);
          if (!subscription || typeof subscription.endpoint !== 'string' || !subscription.endpoint.startsWith('https://')) {
            return jsonError('Invalid subscription', 400);
          }
          
          // Use a hash or trailing part of endpoint as the key
          const key = `sub_${encodeB64(subscription.endpoint).slice(-30)}`;
          await env.PUSH_SUBSCRIBERS.put(key, JSON.stringify(subscription));
          
          return new Response(JSON.stringify({ success: true }), { status: 200, headers: CORS });
        } catch (e) {
          return jsonError('Bad request payload.', 400);
        }
      }
      return jsonError('Method not allowed.', 405);
    }

    // ── Route: /site and /site.html ─────────────────────────────────────────
    if (url.pathname === '/site' || url.pathname === '/site.html') {
      const rawId = url.searchParams.get('id');
      if (url.pathname === '/site.html') {
        const search = rawId ? `?id=${encodeURIComponent(rawId)}` : '';
        return new Response(null, {
          status: 301,
          headers: { 'Location': `${url.origin}/site${search}`, 'Cache-Control': 'public, max-age=604800' }
        });
      }

      if (!rawId) return Response.redirect(`${url.origin}/`, 301);

      // Typo-Squatting / Redirects
      const typos = {
        'nhentiai': 'nhentai',
        'nhentai.net': 'nhentai',
        'hanime.tv': 'hanime',
        'hanime_tv': 'hanime',
        'fakku.net': 'fakku',
        'hitomi.la': 'hitomila',
        'hitomi': 'hitomila',
        'rule34': 'rule34xxx',
        'rule34.xxx': 'rule34xxx'
      };
      if (typos[rawId.toLowerCase()]) {
        return Response.redirect(`${url.origin}/site?id=${typos[rawId.toLowerCase()]}`, 301);
      }

      let site = null;
      let relatedSites = [];
      if (env.hv_directory) {
        try {
          // The rows are cached at the edge for an hour; the visibility rules below
          // run on every render, so a rule change applies at once.
          const parse = row => {
            const s = JSON.parse(row.data_json);
            s.id = s.id || rawId;
            s.category = s.category || row.category;
            return s;
          };
          const siteRow = await edgeCachedJson(ctx, `site-row-v1?id=${encodeURIComponent(rawId)}`, 3600, async () =>
            (await env.hv_directory.prepare('SELECT category, data_json FROM sites WHERE id = ?').bind(rawId).first()) || null);
          if (siteRow && siteRow.data_json) {
            site = parse(siteRow);
            // The whole stored record, as the minor-safety sweep checks it.
            if (!isListingVisible(site) || !isMinorSafe(site.url, siteRow.data_json) || !isSafeHttpUrl(site.url)) site = null;
          }
          if (site) {
            // Related listings are the category's best-rated, cached once per category.
            // They are optional: if the query fails the page renders without them.
            try {
              const rows = await edgeCachedJson(ctx, `category-top-v1?c=${encodeURIComponent(site.category)}`, 3600, async () =>
                (await env.hv_directory.prepare(
                  `SELECT id, data_json FROM sites WHERE category = ? AND ${NOT_PROHIBITED_SQL} ORDER BY rating DESC LIMIT 16`
                ).bind(site.category).all()).results);
              relatedSites = visibleSites(rows.filter(r => r.id !== rawId)).slice(0, 15);
            } catch (err) {
              console.error('related listings unavailable:', err);
            }
          }
        } catch (err) {
          console.error("D1 lookup error:", err);
          return new Response('Temporarily unavailable', { status: 503, headers: { 'Retry-After': '120' } });
        }
      }

      // 410 Gone (not 404): the listing was removed, so Google drops it faster.
      if (!site) return notFoundPage(env, url, 410);

      const response = await env.ASSETS.fetch(new Request(url.origin + '/site'));
      if (!response.ok) return response;

      const canonicalUrl = `https://hentaivault.me/site?id=${encodeURIComponent(site.id)}`;
      const indexable = isIndexable(site);
      const rewriter = new HTMLRewriter()
        .on('link[rel="canonical"]', new CanonicalRemover())
        .on('meta[name="description"]', new CanonicalRemover())
        .on('title', new TitleHandler(`${site.name} Review | HentaiVault`))
        .on('head', new HeadHandler(site, canonicalUrl, effectiveLang, indexable))
        .on('div#reviewContent', new ReviewBodyHandler(site, effectiveLang, relatedSites));

      return withHeaders(rewriter.transform(response), {
        'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=60',
        'Vary': 'Cookie, Accept-Language',
        ...(indexable ? {} : { 'X-Robots-Tag': 'noindex, follow' }),
      });
    }

    // ── Route: /compare ─────────────────────────────────────────────────────
    if (url.pathname === '/compare') {
      const site1Id = url.searchParams.get('site1');
      const site2Id = url.searchParams.get('site2');
      if (!site1Id || !site2Id) return Response.redirect(`${url.origin}/`, 301);

      let site1 = null;
      let site2 = null;
      if (env.hv_directory) {
        try {
          const rows = await env.hv_directory.prepare(`SELECT id, data_json FROM sites WHERE id IN (?, ?) AND ${NOT_PROHIBITED_SQL}`).bind(site1Id, site2Id).all();
          for (const r of rows.results) {
            const parsed = visibleSites([r])[0] || null;
            if (r.id === site1Id) site1 = parsed;
            if (r.id === site2Id) site2 = parsed;
          }
        } catch (e) {}
      }
      if (!site1 || !site2) return notFoundPage(env, url, 410);
      site1.id = site1.id || site1Id;
      site2.id = site2.id || site2Id;

      const response = await env.ASSETS.fetch(new Request(url.origin + '/compare'));
      if (!response.ok) return response;

      const canonicalUrl = `https://hentaivault.me/compare?site1=${encodeURIComponent(site1Id)}&site2=${encodeURIComponent(site2Id)}`;
      const rewriter = new HTMLRewriter()
        .on('link[rel="canonical"]', new CanonicalRemover())
        .on('meta[name="description"]', new CanonicalRemover())
        .on('meta[name="robots"]', new CanonicalRemover())
        .on('title', new TitleHandler(`${site1.name} vs ${site2.name} | HentaiVault`))
        .on('head', new CompareHeadHandler(site1, site2, canonicalUrl))
        .on('main#compareContent', new CompareBodyHandler(site1, site2));

      return withHeaders(rewriter.transform(response), { 'X-Robots-Tag': 'noindex, follow' });
    }

    // ── Route: /out (Interstitial Redirect) ─────────────────────────────────
    if (url.pathname === '/out') {
      const id = url.searchParams.get('id');
      if (!id) return Response.redirect(`${url.origin}/`, 301);

      let site = null;
      if (env.hv_directory) {
        try {
          const row = await env.hv_directory.prepare(`SELECT url, data_json FROM sites WHERE id = ? AND ${NOT_PROHIBITED_SQL}`).bind(id).first();
          if (row && isSafeHttpUrl(row.url) && visibleSites([row]).length) site = { url: affiliateUrlFor(row.url) || row.url };
        } catch (e) {}
      }
      if (!site) return notFoundPage(env, url, 410);

      const response = await env.ASSETS.fetch(new Request(url.origin + '/out'));
      if (!response.ok) return response;

      const rewriter = new HTMLRewriter()
        .on('link[rel="canonical"]', new CanonicalRemover())
        .on('div#target-url', new OutHandler(site));

      return withHeaders(rewriter.transform(response), { 'X-Robots-Tag': 'noindex, nofollow' });
    }

    // ── Route: /embed (Ego-Bait Widget) ─────────────────────────────────────
    // Deliberately without X-Frame-Options/frame-ancestors: other sites embed it.
    if (url.pathname === '/embed') {
      const id = url.searchParams.get('id');
      if (!id) return Response.redirect(`${url.origin}/`, 301);

      let site = null;
      if (env.hv_directory) {
        try {
          const row = await env.hv_directory.prepare(`SELECT data_json FROM sites WHERE id = ? AND ${NOT_PROHIBITED_SQL}`).bind(id).first();
          if (row) site = visibleSites([row])[0] || null;
        } catch (e) {}
      }
      if (!site) return new Response('Gone', { status: 410, headers: { 'X-Robots-Tag': 'noindex' } });
      site.id = site.id || id;

      const response = await env.ASSETS.fetch(new Request(url.origin + '/embed'));
      if (!response.ok) return response;

      const rewriter = new HTMLRewriter()
        .on('link[rel="canonical"]', new CanonicalRemover())
        .on('body', new EmbedHandler(site));

      const out = rewriter.transform(response);
      const headers = new Headers(out.headers);
      headers.set('X-Robots-Tag', 'noindex');
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(out.body, { status: out.status, headers });
    }

    // Native Cloudflare ASSETS handles clean URLs (e.g., /about -> about.html) automatically.
    // Explicitly mapping to .html causes an infinite 307 redirect loop.

    // ── Everything else: serve static assets — with canonical injection ───────
    const response = await env.ASSETS.fetch(request);

    if (response.ok && response.headers.get('content-type')?.includes('text/html')) {
      // Canonical = clean https path without query string (?lang=, ?q=, ?ref= are UI state).
      const clean = new URL(url.toString());
      clean.search = '';
      clean.hash = '';
      clean.protocol = 'https:';
      if (clean.pathname.endsWith('.html')) {
        clean.pathname = clean.pathname === '/index.html' ? '/' : clean.pathname.slice(0, -5);
      }
      const canonicalUrl = clean.toString();

      const rewriter = new HTMLRewriter()
        .on('link[rel="canonical"]', new CanonicalRemover())
        .on('head', new CanonicalInjector(canonicalUrl, effectiveLang));

      // Crawlable links to listings (the browsing UI renders its cards with JS).
      const page = clean.pathname.replace(/\/+$/, '') || '/';
      const hub = HUB_PAGES[page];
      const isGuide = page.startsWith('/blog/');
      if (env.hv_directory && (page === '/' || hub || isGuide)) {
        try {
          const snapshot = await getLinkSnapshot(env, ctx);
          if (page === '/') {
            rewriter.on('section#topSitesByCategory', new HomeTopSites(renderHomeSection(snapshot.sites)));
          } else if (hub) {
            const kept = new Set();
            const visibleIds = new Set(snapshot.sites.map(s => s.id));
            rewriter
              .on('div#sitesGrid > a.site-card', new HubCardFilter(visibleIds, kept))
              .on('div#sitesGrid', new HubGridAppender(snapshot, hub, kept));
          } else {
            const headings = [];
            rewriter
              .on('article h2', new GuideHeadingCollector(headings))
              .on('article h3', new GuideHeadingCollector(headings))
              .on('article', new GuideLinksAppender(snapshot, headings));
          }
        } catch (err) {
          console.error('internal links unavailable:', err); // the page still renders without them
        }
      }

      return addSecurityHeaders(rewriter.transform(response));
    }

    // Custom 404 page for page-like URLs (the assets layer itself returns an empty 404).
    if (response.status === 404 && (request.headers.get('accept')?.includes('text/html') || !url.pathname.includes('.'))) {
      return notFoundPage(env, url, 404);
    }

    // Non-HTML assets (robots.txt, llms.txt, CSS, JS, images, etc.) — return as-is
    return response;
}

async function handleScheduled(event, env, ctx) {
  console.log(`Cron triggered at ${event.cron}`);
  if (!env.hv_directory) return;

  // ── Multi-source site discovery pipeline ─────────────────────────────────
  const SITE_CONTEXT_KEYWORDS = [
    'hentai','ecchi','doujin','manga','anime','adult','nsfw','xxx','porn','erotic',
    'lewd','rule34','booru','nhentai','hanime','uncensored','streaming','visual novel',
    'fanfic','cosplay','waifu','tentacle','yaoi','yuri','futanari',
    'ahegao','ntr','patreon','fanbox','creator','game','comic','tube','studio','hd'
  ];

  // Category guesser based on domain/URL keywords
  function guessCategory(urlStr) {
    const u = urlStr.toLowerCase();
    if (/booru|rule34|gelbooru|danbooru|safebooru|konachan|yandere/.test(u)) return 'Image Boards (Boorus)';
    if (/manga|doujin|nhentai|hitomi|fakku|tsumino/.test(u)) return 'Manga & Doujinshi';
    if (/game|vndb|f95|visual.novel|itch\.io/.test(u)) return 'Games & Visual Novels';
    if (/torrent|nyaa|1337|download|fap|fap-nation/.test(u)) return 'Downloads & Torrents';
    if (/patreon|fanbox|onlyfans|creator|subscribestar/.test(u)) return 'Creator Platforms';
    if (/forum|reddit|discord|chan|board|community/.test(u)) return 'Communities & Forums';
    if (/hentai.*stream|hanime|hstream|watch.*hentai/.test(u)) return 'Hentai Streaming';
    if (/vr|3d|immersive|interactive/.test(u)) return 'Immersive & Interactive';
    if (/tube|porn|xxx|adult|xvideos|xhamster|pornhub/.test(u)) return 'Adult Tubes & Studios';
    if (/anime|crunchyroll|funimation|animepahe|gogoanime/.test(u)) return 'Anime Streaming';
    return 'Hentai Streaming';
  }

  // Shared insert helper — checks context, pings, deduplicates, inserts
  async function tryInsertSite(siteUrl, discoveredBy) {
    try {
      const urlObj = new URL(siteUrl);
      const hostname = urlObj.hostname.replace(/^www\./, '');
      if (!hostname || hostname.length < 4) return false;

      // ── Expanded NOISE blocklist ─────────────────────────────────────────
      const NOISE = [
        // Social / general
        'reddit.com','youtube.com','youtu.be','imgur.com','twitter.com','x.com',
        'instagram.com','facebook.com','tiktok.com','snapchat.com','pinterest.com',
        'linkedin.com','threads.net','mastodon.social','bsky.app',
        // Dev / code hosting
        'github.com','gitlab.com','gitlab.io','bitbucket.org','codeberg.org',
        'sourceforge.net','npmjs.com','pypi.org','rubygems.org','crates.io',
        // Reference / encyclopedias
        'wikipedia.org','wikimedia.org','wikia.com','fandom.com','mediawiki.org',
        'wiktionary.org','wikidata.org','wikihow.com','quora.com',
        // Tech / infra
        'cloudflare.com','discord.com','discord.gg','telegram.org','t.me',
        'slack.com','notion.so','airtable.com','trello.com',
        // Search / aggregators
        'google.com','bing.com','duckduckgo.com','yahoo.com','yandex.com',
        'startpage.com','brave.com',
        // Shorteners / redirectors
        'bit.ly','tinyurl.com','ow.ly','buff.ly','rebrand.ly','short.io',
        'goo.gl','rb.gy','is.gd','v.gd','cutt.ly',
        // File hosts / cloud
        'amazon.com','drive.google.com','docs.google.com','play.google.com',
        'dropbox.com','onedrive.live.com','icloud.com','mega.nz','mediafire.com',
        'archive.org','web.archive.org',
        // Blogs / publishing
        'medium.com','substack.com','tumblr.com','blogspot.com','wordpress.com',
        'blogger.com','ghost.io','hashnode.dev',
        // E-commerce / storefronts (not content)
        'etsy.com','ebay.com','aliexpress.com','shopify.com',
        // App stores
        'apps.apple.com','play.google.com','microsoft.com',
      ];
      if (NOISE.some(n => hostname === n || hostname.endsWith('.' + n))) return false;

      // ── Reject sub-page URLs — only accept root/top-level domains ──────────
      // Allows: https://nhentai.net, https://nhentai.net/
      // Rejects: https://wikipedia.org/wiki/Doujin, https://github.com/user/repo
      //          https://reddit.com/r/hentai, https://xnxx.com/search/hentai
      const pathDepth = urlObj.pathname.replace(/\/$/, '').split('/').filter(Boolean).length;
      if (pathDepth > 0) return false; // Only accept root-level URLs

      // ── Context check: keyword must appear in the HOSTNAME, not just path ──
      // Prevents: wikipedia.org/wiki/doujin_soft passing because "doujin" is in path
      const hostLower = hostname.toLowerCase();
      if (!isMinorSafe(siteUrl)) return false;
      const fitsContext = SITE_CONTEXT_KEYWORDS.some(k => hostLower.includes(k));
      if (!fitsContext) return false;

      // Duplicate check (live directory and review queue)
      const existing = await env.hv_directory.prepare(
        'SELECT 1 FROM sites WHERE url = ?1 UNION ALL SELECT 1 FROM queue WHERE url = ?1 LIMIT 1'
      ).bind(siteUrl).first();
      if (existing) return false;

      // Live ping
      const ping = await fetch(siteUrl, {
        method: 'HEAD',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(5000)
      });
      const isUp = ping.status >= 200 && ping.status < 500 && ping.status !== 404;
      if (!isUp) return false;

      // Discoveries go to the review queue; the daily-add pipeline scores, filters
      // and enriches them before anything is published to the live directory.
      const category = guessCategory(siteUrl);
      const result = await env.hv_directory.prepare(
        "INSERT OR IGNORE INTO queue (id, url, category, name, status) VALUES (?, ?, ?, ?, 'pending')"
      ).bind(makeId(hostname), siteUrl, category, hostname).run();
      return (result.meta?.changes || 0) > 0;
    } catch(e) { return false; }
  }

  let totalInserted = 0;

  // ── SOURCE 1: Reddit Subreddits (posts) ──────────────────────────────────
  try {
    const subreddits = ['hentai', 'animepiracy', 'animedubs', 'ecchi', 'doujinshi', 'manhwa', 'rule34', 'hentaivideo', 'nsfw_games', 'visualnovels', 'yuri', 'yaoi', 'MangaPiracy', 'Piracy'];
    for (const sub of subreddits) {
      try {
        const res = await fetch(`https://www.reddit.com/r/${sub}/new.json?limit=25`, {
          headers: { 'User-Agent': 'HV-Scout-Bot/3.0' }
        });
        if (!res.ok) continue;
        const data = await res.json();
        for (const post of data.data.children) {
          const text = `${post.data.selftext || ''} ${post.data.url || ''} ${post.data.title || ''}`;
          const urls = text.match(/https?:\/\/[^\s"'()<>]+/g) || [];
          for (const u of urls) {
            // Normalize to root origin — prevents sub-page junk from sneaking in
            try {
              const origin = new URL(u).origin;
              if (await tryInsertSite(origin, 'Reddit Posts')) totalInserted++;
            } catch(e) { /* bad URL */ }
          }
        }
      } catch(e) { /* ignore */ }
    }
    console.log(`Source 1 (Reddit Posts): ${totalInserted} total inserted so far.`);
  } catch(err) { console.error('Reddit posts error:', err); }

  // ── SOURCE 2: Reddit Wiki Pages (curated mega-lists) ─────────────────────
  try {
    const wikiPages = [
      'https://www.reddit.com/r/animepiracy/wiki/index.json',
      'https://www.reddit.com/r/hentai/wiki/index.json',
      'https://www.reddit.com/r/Piracy/wiki/megathread/anime.json',
      'https://www.reddit.com/r/Piracy/wiki/megathread/nsfw.json',
      'https://www.reddit.com/r/MangaPiracy/wiki/index.json',
    ];
    for (const wikiUrl of wikiPages) {
      try {
        const res = await fetch(wikiUrl, { headers: { 'User-Agent': 'HV-Scout-Bot/3.0' } });
        if (!res.ok) continue;
        const data = await res.json();
        const content = data?.data?.content_md || data?.data?.content_html || '';
        const urls = content.match(/https?:\/\/[^\s"'()<>\]]+/g) || [];
        for (const u of urls) {
          try {
            const origin = new URL(u).origin;
            if (await tryInsertSite(origin, 'Reddit Wiki')) totalInserted++;
          } catch(e) { /* bad URL */ }
        }
      } catch(e) { /* ignore */ }
    }
    console.log(`Source 2 (Reddit Wikis): ${totalInserted} total inserted so far.`);
  } catch(err) { console.error('Reddit wiki error:', err); }

  // ── SOURCE 3: crt.sh Certificate Transparency Logs ───────────────────────
  try {
    // Rotate through keyword list each cron run to avoid hammering
    const crtKeywords = ['hentai','anime-stream','manga','doujin','ecchi','hanime','nhentai','rule34','booru','f95zone','pornhwa','yaoi','yuri','eroge'];
    const crtIdx = Math.floor(Date.now() / (12 * 60 * 60 * 1000)) % crtKeywords.length;
    const keyword = crtKeywords[crtIdx];

    const crtRes = await fetch(`https://crt.sh/?q=%.${keyword}.%&output=json`, {
      headers: { 'User-Agent': 'HV-Scout-Bot/3.0' },
      signal: AbortSignal.timeout(10000)
    });
    if (crtRes.ok) {
      const crtData = await crtRes.json();
      const domains = new Set();
      for (const entry of crtData.slice(0, 200)) {
        const name = (entry.common_name || entry.name_value || '').toLowerCase();
        // Skip wildcards, IP addresses, and subdomains with too many parts
        if (name.startsWith('*') || /^\d+\.\d+/.test(name)) continue;
        const parts = name.split('.');
        if (parts.length > 4) continue;
        domains.add(`https://${name}`);
      }
      for (const domainUrl of domains) {
        if (await tryInsertSite(domainUrl, 'crt.sh')) totalInserted++;
      }
    }
    console.log(`Source 3 (crt.sh - "${keyword}"): ${totalInserted} total inserted so far.`);
  } catch(err) { console.error('crt.sh error:', err); }

  // ── SOURCE 4: Wayback Machine CDX API ────────────────────────────────────
  try {
    const cdxKeywords = ['hentai','nhentai','hanime','anime-stream','doujin','rule34','booru','pornhwa'];
    const cdxIdx = Math.floor(Date.now() / (12 * 60 * 60 * 1000)) % cdxKeywords.length;
    const cdxKw = cdxKeywords[cdxIdx];

    const cdxRes = await fetch(
      `https://web.archive.org/cdx/search/cdx?url=*.${cdxKw}.*&output=json&fl=original&limit=150&collapse=urlkey&filter=statuscode:200`,
      { headers: { 'User-Agent': 'HV-Scout-Bot/3.0' }, signal: AbortSignal.timeout(10000) }
    );
    if (cdxRes.ok) {
      const cdxData = await cdxRes.json();
      // First row is header ["original"], skip it
      for (const row of cdxData.slice(1, 100)) {
        const siteUrl = row[0];
        if (!siteUrl) continue;
        try {
          const origin = new URL(siteUrl).origin;
          if (await tryInsertSite(origin, 'Wayback Machine')) totalInserted++;
        } catch(e) { /* bad URL */ }
      }
    }
    console.log(`Source 4 (Wayback CDX - "${cdxKw}"): ${totalInserted} total inserted so far.`);
  } catch(err) { console.error('Wayback CDX error:', err); }

  // ── SOURCE 5: GitHub Awesome-Lists ───────────────────────────────────────
  try {
    const ghKeywords = ['anime hentai sites list', 'manga sites', 'doujin sites', 'nsfw gaming list'];
    const ghIdx = Math.floor(Date.now() / (12 * 60 * 60 * 1000)) % ghKeywords.length;
    const ghKw = ghKeywords[ghIdx];

    const ghRes = await fetch(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(ghKw)}&sort=stars&per_page=5`,
      { headers: { 'User-Agent': 'HV-Scout-Bot/3.0', 'Accept': 'application/vnd.github.v3+json' } }
    );
    if (ghRes.ok) {
      const ghData = await ghRes.json();
      for (const repo of (ghData.items || []).slice(0, 5)) {
        try {
          // Fetch README
          const readmeRes = await fetch(
            `https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch}/README.md`,
            { headers: { 'User-Agent': 'HV-Scout-Bot/3.0' }, signal: AbortSignal.timeout(5000) }
          );
          if (!readmeRes.ok) continue;
          const readme = await readmeRes.text();
          const urls = readme.match(/https?:\/\/[^\s"'()<>\]]+/g) || [];
          for (const u of urls) {
            try {
              const origin = new URL(u).origin;
              if (await tryInsertSite(origin, 'GitHub Lists')) totalInserted++;
            } catch(e) { /* bad URL */ }
          }
        } catch(e) { /* ignore per-repo errors */ }
      }
    }
    console.log(`Source 5 (GitHub Lists): ${totalInserted} total inserted so far.`);
  } catch(err) { console.error('GitHub lists error:', err); }

  // ── SOURCE 6: Hacker News Algolia Search ───────────────────────────────
  try {
    const hnKeywords = ['anime streaming', 'manga reader', 'visual novel', 'doujin', 'piracy site'];
    const hnIdx = Math.floor(Date.now() / (12 * 60 * 60 * 1000)) % hnKeywords.length;
    const hnKw = hnKeywords[hnIdx];

    const hnRes = await fetch(
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(hnKw)}&hitsPerPage=20`,
      { headers: { 'User-Agent': 'HV-Scout-Bot/3.0' } }
    );
    if (hnRes.ok) {
      const hnData = await hnRes.json();
      for (const hit of hnData.hits || []) {
        // extract from URL
        if (hit.url) {
          if (await tryInsertSite(hit.url.split('?')[0], 'HackerNews')) totalInserted++;
        }
        // extract from text/comments
        const text = `${hit.title || ''} ${hit.story_text || ''} ${hit.comment_text || ''}`;
        const urls = text.match(/https?:\/\/[^\s"'()<>\]]+/g) || [];
        for (const u of urls) {
          if (await tryInsertSite(u.split('?')[0], 'HackerNews')) totalInserted++;
        }
      }
    }
    console.log(`Source 6 (HackerNews - "${hnKw}"): ${totalInserted} total inserted so far.`);
  } catch(err) { console.error('HackerNews search error:', err); }

  console.log(`Discovery pipeline complete. Total new sites inserted: ${totalInserted}.`);

  // ── Periodic DB Health Sweep (prune dead sites from existing DB) ──────────
  try {
    // Grab a rolling batch of 30 sites to re-verify each cron run (cycles through the whole DB over time)
    const sweepSeed = Math.floor(Date.now() / (12 * 60 * 60 * 1000)); // changes every 12h
    const countRow = await env.hv_directory.prepare('SELECT COUNT(*) AS n FROM sites').first();
    const sweepOffset = (sweepSeed * 30) % Math.max(1, countRow?.n || 1);
    const { results: sitesToSweep } = await env.hv_directory.prepare(
      'SELECT id, url FROM sites ORDER BY id LIMIT 30 OFFSET ?'
    ).bind(sweepOffset).all();

    // Store real JSON booleans (the frontend checks `isUp === false`) and clear the
    // flag again when a site recovers, so a single timeout isn't permanent.
    const setStatus = (id, up) => env.hv_directory.prepare(
      up
        ? "UPDATE sites SET data_json = json_remove(json_set(data_json, '$.isUp', json('true')), '$.isDeadFlagged') WHERE id = ?"
        : "UPDATE sites SET data_json = json_set(data_json, '$.isUp', json('false'), '$.isDeadFlagged', json('true')) WHERE id = ?"
    ).bind(id).run();

    let sweptDead = 0;
    for (const site of sitesToSweep) {
      let isUp = false;
      try {
        const ping = await fetch(site.url, {
          method: 'HEAD',
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          signal: AbortSignal.timeout(4000)
        });
        isUp = ping.status >= 200 && ping.status < 500 && ping.status !== 404;
      } catch (e) {
        isUp = false;
      }
      await setStatus(site.id, isUp);
      if (!isUp) sweptDead++;
    }
    console.log(`Health sweep: ${sweptDead}/${sitesToSweep.length} sites flagged offline.`);
  } catch(err) {
    console.error('Health sweep error:', err);
  }


}

// ─── Submit Handler ───────────────────────────────────────────────────────────

async function handleSubmit(request, env, ctx) {
  try {
    const ip = request.headers.get('cf-connecting-ip');
    if (await checkRateLimit(ip, env)) {
      return jsonError('Too many submissions. Please try again later.', 429);
    }

    const body = await request.json().catch(() => null);
    if (!body) return jsonError('Invalid request body.', 400);

    const { name, url, category, description } = body;

    // ── 1. Bot check ─────────────────────────────────────────────────────────
    const human = await verifyHuman(body, ip, env);
    if (!human.ok) return jsonError(human.error, 400);

    // ── 2. Validate Inputs ───────────────────────────────────────────────────
    const nameClean = sanitize(name);
    const descClean = sanitize(description);
    const urlClean  = String(url || '').trim().slice(0, 500);
    const catClean  = normalizeCategory(category);

    if (!nameClean || nameClean.length < 2)
      return jsonError('Site name must be at least 2 characters.', 400);

    if (!isValidURL(urlClean))
      return jsonError('Please provide a valid http:// or https:// URL.', 400);

    if (!CATEGORIES.includes(catClean))
      return jsonError('Invalid category selected.', 400);

    // Minor safety: anything blocked or restricted is refused automatically.
    if (!isMinorSafe(urlClean, nameClean, descClean))
      return jsonError('This site cannot be listed on HentaiVault.', 422);

    if (!descClean || descClean.length < 20)
      return jsonError('Description must be at least 20 characters.', 400);

    // GitHub token check removed — submissions now go directly to D1

    // ── 3. Duplicate check via D1 ────────────────────────────────────────────
    if (!env.hv_directory) return jsonError('Database not configured.', 500);
    const existing = await env.hv_directory.prepare('SELECT id FROM sites WHERE url = ?').bind(urlClean).first();
    if (existing) {
      return jsonError('This site is already listed in the directory!', 409);
    }
    const queued = await env.hv_directory.prepare('SELECT status FROM queue WHERE url = ?').bind(urlClean).first();
    if (queued) {
      return jsonError('This site has already been submitted and is awaiting review.', 409);
    }

    // ── 3b. Live reachability check ──────────────────────────────────────────
    try {
      const pingRes = await fetch(urlClean, {
        method: 'HEAD',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(5000)
      });
      const isUp = pingRes.status >= 200 && pingRes.status < 500 && pingRes.status !== 404;
      if (!isUp) {
        return jsonError('That site appears to be offline or unreachable right now. Please try again later.', 422);
      }
    } catch (e) {
      return jsonError('Could not reach that site. Please check the URL and try again.', 422);
    }

    // ── 3c. Context relevance check ──────────────────────────────────────────
    const CONTEXT_KEYWORDS = [
      'hentai','ecchi','doujin','manga','anime','adult','nsfw','xxx','porn','erotic',
      'lewd','rule34','booru','nhentai','hanime','uncensored','streaming','visual novel',
      'fanfic','cosplay','waifu','tentacle','yaoi','yuri','futanari',
      'ahegao','ntr','patreon','fanbox','creator','game','comic','tube','studio'
    ];
    const textToCheck = `${nameClean} ${descClean} ${catClean}`.toLowerCase();
    const fitsContext = CONTEXT_KEYWORDS.some(k => textToCheck.includes(k));
    if (!fitsContext) {
      return jsonError('This site does not appear to be relevant to the HentaiVault directory (adult/anime/hentai content).', 422);
    }

    // ── 3d. Clef/Jev screening ────────────────────────────────────────────────
    const aiVerdict = await decide(
      env,
      { name: nameClean, url: urlClean, category: catClean, description: descClean },
      SUBMISSION_QUESTIONS
    );
    if (aiVerdict?.answers) {
      const rel = aiVerdict.answers.relevant?.noul;
      const risk = aiVerdict.answers.minor_risk?.noul;
      if (typeof rel === 'number' && rel < MIN_RELEVANCE) {
        return jsonError('This site does not appear to be relevant to the HentaiVault directory.', 422);
      }
      if (typeof risk === 'number' && risk >= MAX_MINOR_RISK) {
        return jsonError('This site cannot be listed on HentaiVault.', 422);
      }
    }

    // ── 4. Queue for review ──────────────────────────────────────────────────
    // Submissions are not published directly: the daily-add pipeline scores,
    // filters and enriches queued sites before they reach the live directory.
    await env.hv_directory.prepare(
      "INSERT INTO queue (id, url, category, name, status) VALUES (?, ?, ?, ?, 'pending')"
    ).bind(makeId(nameClean), urlClean, catClean, nameClean).run();

    return new Response(
      JSON.stringify({
        success: true,
        message: `Thanks! "${nameClean}" has been submitted and will appear once it passes review.`,
      }),
      { status: 200, headers: CORS }
    );

  } catch (err) {
    console.error('Unexpected error:', err);
    return jsonError('An unexpected error occurred.', 500);
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function isValidURL(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/[\\"`<>&]/g, '')
    .replace(/[\r\n\t]/g, ' ')
    .trim()
    .slice(0, 300);
}

function makeId(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30)
    + '_' + Date.now().toString(36);
}

function encodeB64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

/**
 * Bot protection for the public write endpoints (submissions, reviews), on top of
 * the per-IP rate limit each caller applies first.
 * - A hidden "website" honeypot field must be empty (bots fill every field).
 * - When TURNSTILE_SECRET_KEY is configured, the Turnstile token is verified too.
 */
async function verifyHuman(body, ip, env) {
  if (body && typeof body.website === 'string' && body.website.trim() !== '') {
    return { ok: false, error: 'Submission rejected.' };
  }
  if (!env.TURNSTILE_SECRET_KEY) return { ok: true };
  if (!body || !body.turnstileToken) return { ok: false, error: 'Please complete the CAPTCHA.' };
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET_KEY);
  form.append('response', body.turnstileToken);
  if (ip) form.append('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const data = await res.json();
    return data.success ? { ok: true } : { ok: false, error: 'CAPTCHA verification failed. Please try again.' };
  } catch {
    return { ok: false, error: 'CAPTCHA verification is unavailable. Please try again later.' };
  }
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: CORS });
}
