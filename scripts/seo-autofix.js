/**
 * HentaiVault SEO Auto-Fix Engine
 * 
 * Called by the seo-monitor GitHub Actions workflow.
 * Receives GSC data as JSON, diagnoses issues, applies fixes,
 * and writes a structured report.
 * 
 * Usage: node scripts/seo-autofix.js [--dry-run]
 * 
 * Environment variables required:
 *   GSC_SERVICE_ACCOUNT_JSON — JSON string of the GCP service account key
 *   SITE_URL                 — The GSC property (e.g. sc-domain:hentaivault.me)
 */

const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const REPORT_PATH = path.join(__dirname, '..', 'reports', 'seo-status.md');
const INDEX_JS_PATH = path.join(__dirname, '..', 'src', 'index.js');
const INDEX_HTML_PATH = path.join(__dirname, '..', 'index.html');

// ─── Thresholds ────────────────────────────────────────────────────────────
const CTR_DROP_THRESHOLD = 0.20;       // Alert if CTR drops > 20%
const IMPRESSION_DROP_THRESHOLD = 0.25; // Alert if impressions drop > 25%
const LOW_CTR_THRESHOLD = 0.02;        // Flag queries with CTR < 2%
const BAD_POSITION_THRESHOLD = 15;     // Flag queries ranking past position 15
const BRANDED_TERMS = ['hentaivault', 'hentai vault', 'hentaivm', 'hentavn', 'hentaiv'];
const OPPORTUNITY_POSITION_MIN = 5;    // Queries ranking 5–30 are actionable
const OPPORTUNITY_POSITION_MAX = 30;
const OPPORTUNITY_IMPRESSIONS_MIN = 5; // At least 5 impressions to matter
const YEAR = new Date().getFullYear();

// ─── Fetch GSC data via API ─────────────────────────────────────────────────
async function fetchGscData(auth, siteUrl, startDate, endDate, dimensions, rowLimit = 100) {
  const { google } = require('googleapis');
  const webmasters = google.webmasters({ version: 'v3', auth });
  try {
    const res = await webmasters.searchanalytics.query({
      siteUrl,
      requestBody: { startDate, endDate, dimensions, rowLimit },
    });
    return res.data.rows || [];
  } catch (err) {
    console.error(`GSC API error for ${siteUrl}: ${err.message}`);
    return [];
  }
}

// ─── Date helpers ────────────────────────────────────────────────────────────
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

// ─── Fix: Update homepage meta description if needed ────────────────────────
function fixHomepageMetaDescription(issues) {
  if (!fs.existsSync(INDEX_HTML_PATH)) return false;
  let html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const currentMeta = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
  const currentDesc = currentMeta ? currentMeta[1] : '';

  // Check if description is too short or generic
  if (currentDesc.length >= 140 && !issues.includes('meta_desc_too_short')) return false;

  const newDesc = 'HentaiVault — The ultimate ranked directory of 1,200+ hentai, anime, manga, and adult sites. Curated reviews, safety ratings, and alternatives. Updated daily.';
  if (currentDesc === newDesc) return false;

  if (!DRY_RUN) {
    const updated = html.replace(
      /<meta\s+name="description"\s+content="[^"]*"/i,
      `<meta name="description" content="${newDesc}"`
    );
    if (updated !== html) {
      fs.writeFileSync(INDEX_HTML_PATH, updated, 'utf8');
      return true;
    }
  }
  return !DRY_RUN ? false : true; // dry run always reports as "would fix"
}

// ─── Fix: Ensure homepage title has non-brand keywords ───────────────────────
function fixHomepageTitleTag(topQueries) {
  if (!fs.existsSync(INDEX_HTML_PATH)) return false;
  let html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const currentTitle = html.match(/<title>([^<]+)<\/title>/i);
  const titleText = currentTitle ? currentTitle[1] : '';

  // Only update if title is purely branded with no keyword modifiers
  const hasNonBrand = /alternative|directory|streaming|hentai site|manga|anime/i.test(titleText);
  if (hasNonBrand) return false;

  // Build keyword-rich title incorporating top non-branded queries
  const nonBranded = topQueries
    .filter(r => !r.keys[0].toLowerCase().includes('hentaivault'))
    .slice(0, 1)
    .map(r => r.keys[0]);

  const targetKeyword = nonBranded[0] || 'hentai site directory';
  const newTitle = `HentaiVault — #1 ${targetKeyword.charAt(0).toUpperCase() + targetKeyword.slice(1)} & Anime Directory | 1200+ Curated Sites`;

  if (titleText === newTitle) return false;

  if (!DRY_RUN) {
    const updated = html.replace(/<title>[^<]+<\/title>/i, `<title>${newTitle}</title>`);
    if (updated !== html) {
      fs.writeFileSync(INDEX_HTML_PATH, updated, 'utf8');
      return true;
    }
  }
  return true;
}

// ─── Fix: Auto-update blog meta descriptions for freshness & CTR ────────────
function fixBlogMetaDescriptions(blogFiles) {
  let fixed = 0;
  const blogDir = path.join(__dirname, '..', 'blog');

  for (const file of blogFiles) {
    const filePath = path.join(blogDir, file);
    if (!fs.existsSync(filePath)) continue;
    let content = fs.readFileSync(filePath, 'utf8');
    const metaMatch = content.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
    if (!metaMatch) continue;

    const desc = metaMatch[1];
    // Refresh if description doesn't mention current year
    if (desc.includes(String(YEAR))) continue;

    // Only roll the year forward. (Randomised site counts and appended hooks made
    // every run rewrite the same pages with different numbers.)
    const newDesc = desc.replace(/\b202[0-9]\b/g, String(YEAR));
    if (newDesc === desc) continue;

    const updated = content.replace(
      /<meta\s+name="description"\s+content="[^"]+"/i,
      `<meta name="description" content="${newDesc}"`
    );
    if (updated !== content && !DRY_RUN) {
      fs.writeFileSync(filePath, updated, 'utf8');
      fixed++;
    } else if (DRY_RUN) fixed++;
  }
  return fixed;
}

// ─── Detect non-branded opportunities (queries to target) ────────────────────
function detectOpportunities(rows) {
  const opportunities = [];
  for (const r of rows) {
    const query = r.keys ? r.keys[0] : '';
    const isBranded = BRANDED_TERMS.some(t => query.toLowerCase().includes(t));
    if (isBranded) continue;
    if (
      r.impressions >= OPPORTUNITY_IMPRESSIONS_MIN &&
      r.position >= OPPORTUNITY_POSITION_MIN &&
      r.position <= OPPORTUNITY_POSITION_MAX
    ) {
      opportunities.push({
        query,
        page: r.keys[1] || '',
        impressions: r.impressions,
        clicks: r.clicks,
        ctr: r.ctr,
        position: r.position,
      });
    }
  }
  // Sort by impression volume (biggest quick-win first)
  return opportunities.sort((a, b) => b.impressions - a.impressions).slice(0, 15);
}

// ─── Fix: Ensure gsc-credentials.json is in .gitignore ──────────────────────
function fixGitignore() {
  const gitignorePath = path.join(__dirname, '..', '.gitignore');
  if (!fs.existsSync(gitignorePath)) return false;
  const content = fs.readFileSync(gitignorePath, 'utf8');
  const lines = ['gsc-credentials.json', 'fetch-gsc.js', '*.json.key'];
  let updated = content;
  let changed = false;
  for (const line of lines) {
    if (!content.includes(line)) {
      updated += `\n${line}`;
      changed = true;
    }
  }
  if (changed && !DRY_RUN) {
    fs.writeFileSync(gitignorePath, updated, 'utf8');
  }
  return changed;
}

// ─── Check: Blog canonical tags ─────────────────────────────────────────────
function checkBlogCanonicals() {
  const blogDir = path.join(__dirname, '..', 'blog');
  const issues = [];
  if (!fs.existsSync(blogDir)) return issues;
  const files = fs.readdirSync(blogDir).filter(f => f.endsWith('.html'));
  for (const file of files) {
    const content = fs.readFileSync(path.join(blogDir, file), 'utf8');
    if (!content.includes('rel="canonical"')) {
      issues.push(file);
    }
  }
  return issues;
}

// ─── Fix: Blog canonical tags ───────────────────────────────────────────────
function fixBlogCanonicals(missingCanonicals) {
  let fixed = 0;
  const blogDir = path.join(__dirname, '..', 'blog');
  for (const file of missingCanonicals) {
    const filePath = path.join(blogDir, file);
    const slug = file.replace('.html', '');
    const canonicalUrl = `https://hentaivault.me/blog/${slug}`;
    let content = fs.readFileSync(filePath, 'utf8');
    const canonical = `<link rel="canonical" href="${canonicalUrl}">`;
    const updated = content.replace('</head>', `  ${canonical}\n</head>`);
    if (updated !== content && !DRY_RUN) {
      fs.writeFileSync(filePath, updated, 'utf8');
      fixed++;
    } else if (DRY_RUN) fixed++;
  }
  return fixed;
}

// ─── Ping IndexNow ──────────────────────────────────────────────────────────
async function pingIndexNow(urls) {
  // Read IndexNow key from index.js
  const indexJs = fs.readFileSync(INDEX_JS_PATH, 'utf8');
  const keyMatch = indexJs.match(/indexNowKey\s*=\s*['"]([^'"]+)['"]/);
  const key = keyMatch ? keyMatch[1] : null;
  if (!key) return 0;

  try {
    const payload = {
      host: 'hentaivault.me',
      key,
      keyLocation: `https://hentaivault.me/${key}.txt`,
      urlList: urls.slice(0, 10000),
    };
    const resp = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    });
    return resp.status;
  } catch (err) {
    return 0;
  }
}

// ─── Regenerate sitemaps ─────────────────────────────────────────────────────
async function regenerateSitemaps() {
  const sitemapGen = path.join(__dirname, 'sitemap-gen.js');
  if (!fs.existsSync(sitemapGen)) return false;
  try {
    require(sitemapGen);
    return true;
  } catch (err) {
    console.error('Sitemap gen error:', err.message);
    return false;
  }
}

// ─── Generate Markdown Report ────────────────────────────────────────────────
function buildReport({ runDate, currentMetrics, prevMetrics, issues, fixes, rawRows, opportunities }) {
  const lines = [];
  lines.push(`# 🤖 HentaiVault SEO Auto-Monitor Report`);
  lines.push(`_Last run: ${runDate} UTC • ${DRY_RUN ? '**DRY RUN**' : 'Live mode'}_\n`);
  lines.push(`---\n`);

  // ── Current snapshot
  lines.push(`## 📊 GSC Snapshot (Last 7 Days)`);
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Total Clicks | **${currentMetrics.clicks}** |`);
  lines.push(`| Total Impressions | **${currentMetrics.impressions}** |`);
  lines.push(`| Average CTR | **${(currentMetrics.ctr * 100).toFixed(2)}%** |`);
  lines.push(`| Average Position | **${currentMetrics.position.toFixed(1)}** |`);
  lines.push(``);

  // ── Week-over-week trend
  if (prevMetrics) {
    const clicksDiff = currentMetrics.clicks - prevMetrics.clicks;
    const impDiff = currentMetrics.impressions - prevMetrics.impressions;
    const clickIcon = clicksDiff >= 0 ? '📈' : '📉';
    const impIcon = impDiff >= 0 ? '📈' : '📉';
    lines.push(`## 📅 Week-over-Week Trend`);
    lines.push(`| Metric | This Week | Last Week | Change |`);
    lines.push(`|---|---|---|---|`);
    lines.push(`| Clicks | ${currentMetrics.clicks} | ${prevMetrics.clicks} | ${clickIcon} ${clicksDiff > 0 ? '+' : ''}${clicksDiff} |`);
    lines.push(`| Impressions | ${currentMetrics.impressions} | ${prevMetrics.impressions} | ${impIcon} ${impDiff > 0 ? '+' : ''}${impDiff} |`);
    lines.push(``);
  }

  // ── Top queries
  lines.push(`## 🔍 Top 10 Queries by Clicks`);
  lines.push(`| Query | Clicks | Impressions | CTR | Position |`);
  lines.push(`|---|---|---|---|---|`);
  const top10 = rawRows.slice(0, 10);
  for (const r of top10) {
    const query = r.keys ? r.keys[0] : '—';
    lines.push(`| \`${query}\` | ${r.clicks} | ${r.impressions} | ${(r.ctr * 100).toFixed(2)}% | ${r.position.toFixed(1)} |`);
  }
  lines.push(``);

  // ── Issues detected
  lines.push(`## ⚠️ Issues Detected`);
  if (issues.length === 0) {
    lines.push(`_No critical issues detected this run._`);
  } else {
    for (const issue of issues) {
      lines.push(`- 🔴 ${issue}`);
    }
  }
  lines.push(``);

  // ── Fixes applied
  lines.push(`## 🔧 Fixes Applied This Run`);
  if (fixes.length === 0) {
    lines.push(`_No automatic fixes needed this run._`);
  } else {
    for (const fix of fixes) {
      lines.push(`- ✅ ${fix}`);
    }
  }
  lines.push(``);

  // ── Opportunities section
  if (opportunities && opportunities.length > 0) {
    lines.push(`## 🚀 Non-Branded Keyword Opportunities`);
    lines.push(`_Queries where we appear but don't rank well yet — highest ROI targets_`);
    lines.push(`| Query | Position | Impressions | Clicks | CTR |`);
    lines.push(`|---|---|---|---|---|`);
    for (const o of opportunities) {
      const posIcon = o.position <= 10 ? '🟡' : o.position <= 20 ? '🟠' : '🔴';
      lines.push(`| \`${o.query}\` | ${posIcon} ${o.position.toFixed(1)} | ${o.impressions} | ${o.clicks} | ${(o.ctr * 100).toFixed(1)}% |`);
    }
    lines.push(``);
    lines.push(`> 💡 **Action:** Create or improve content targeting these queries. Each position-1 shift = estimated +15% more clicks.`);
    lines.push(``);
  } else {
    lines.push(`## 🚀 Non-Branded Keyword Opportunities`);
    lines.push(`_No non-branded queries detected in GSC data yet. Growth expected as blog posts mature._`);
    lines.push(``);
  }

  // ── Traffic health summary
  const brandedClicks = rawRows
    .filter(r => r.keys && BRANDED_TERMS.some(t => r.keys[0].toLowerCase().includes(t)))
    .reduce((s, r) => s + r.clicks, 0);
  const nonBrandedClicks = currentMetrics.clicks - brandedClicks;
  const brandedPct = currentMetrics.clicks > 0 ? ((brandedClicks / currentMetrics.clicks) * 100).toFixed(1) : 0;
  lines.push(`## 🏥 Traffic Health`);
  lines.push(`| Signal | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Branded Clicks | ${brandedClicks} (${brandedPct}%) |`);
  lines.push(`| Non-Branded Clicks | ${nonBrandedClicks} (${(100 - parseFloat(brandedPct)).toFixed(1)}%) |`);
  lines.push(`| Organic Diversity Score | ${opportunities ? opportunities.length : 0} active non-branded opportunities |`);
  lines.push(``);

  lines.push(`---`);
  lines.push(`_This report is auto-generated by the SEO Monitor pipeline. Next run in ~6 hours._`);

  return lines.join('\n');
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🤖 HentaiVault SEO Auto-Monitor starting...${DRY_RUN ? ' [DRY RUN]' : ''}\n`);

  // ── 1. Auth
  const { google } = require('googleapis');
  let credentials;
  if (process.env.GSC_SERVICE_ACCOUNT_JSON) {
    credentials = JSON.parse(process.env.GSC_SERVICE_ACCOUNT_JSON);
  } else if (fs.existsSync(path.join(__dirname, '..', 'gsc-credentials.json'))) {
    credentials = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'gsc-credentials.json'), 'utf8'));
  } else {
    console.error('ERROR: GSC_SERVICE_ACCOUNT_JSON env var not set and gsc-credentials.json not found.');
    process.exit(1);
  }
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });

  // ── 2. Fetch current period (last 7 days) and comparison (8–14 days ago)
  const today = daysAgo(2); // GSC has ~2 day data lag
  const weekStart = daysAgo(9);
  const prevWeekStart = daysAgo(16);
  const prevWeekEnd = daysAgo(10);

  const siteUrls = ['sc-domain:hentaivault.me', 'https://hentaivault.me/'];
  let siteUrl = null;
  let currentRows = [];
  let prevRows = [];

  for (const url of siteUrls) {
    // Fetch query and page dimensions so we can map issues to files
    const rows = await fetchGscData(auth, url, weekStart, today, ['query', 'page'], 200);
    if (rows.length > 0) {
      siteUrl = url;
      currentRows = rows;
      prevRows = await fetchGscData(auth, url, prevWeekStart, prevWeekEnd, ['query', 'page'], 200);
      break;
    }
  }

  if (currentRows.length === 0) {
    console.error('ERROR: No GSC data found for either property type. Has the service account been added to GSC?');
    process.exit(1);
  }

  console.log(`✅ Connected to GSC property: ${siteUrl}`);
  console.log(`📊 Fetched ${currentRows.length} query/page rows for current period`);
  console.log(`📊 Fetched ${prevRows.length} query/page rows for comparison period`);

  // ── 3. Aggregate metrics
  const aggregate = (rows) => rows.reduce((acc, r) => ({
    clicks: acc.clicks + (r.clicks || 0),
    impressions: acc.impressions + (r.impressions || 0),
    ctr: 0, // computed after
    position: acc.position + (r.position || 0),
    count: acc.count + 1,
  }), { clicks: 0, impressions: 0, ctr: 0, position: 0, count: 0 });

  const cur = aggregate(currentRows);
  cur.ctr = cur.impressions > 0 ? cur.clicks / cur.impressions : 0;
  cur.position = cur.count > 0 ? cur.position / cur.count : 0;

  const prev = aggregate(prevRows);
  prev.ctr = prev.impressions > 0 ? prev.clicks / prev.impressions : 0;
  prev.position = prev.count > 0 ? prev.position / prev.count : 0;

  // ── 4. Diagnose issues
  const issues = [];
  const fixes = [];

  // CTR drop
  if (prev.clicks > 0) {
    const ctrDropPct = (prev.clicks - cur.clicks) / prev.clicks;
    if (ctrDropPct > CTR_DROP_THRESHOLD) {
      issues.push(`Clicks dropped ${(ctrDropPct * 100).toFixed(1)}% vs last week (${prev.clicks} → ${cur.clicks})`);
    }
  }

  // Impression drop
  if (prev.impressions > 0) {
    const impDropPct = (prev.impressions - cur.impressions) / prev.impressions;
    if (impDropPct > IMPRESSION_DROP_THRESHOLD) {
      issues.push(`Impressions dropped ${(impDropPct * 100).toFixed(1)}% vs last week (${prev.impressions} → ${cur.impressions})`);
    }
  }

  // Low CTR queries with high impressions (Opportunity)
  const lowCtrHighImp = currentRows.filter(r => r.ctr < LOW_CTR_THRESHOLD && r.impressions > 50);
  if (lowCtrHighImp.length > 0) {
    issues.push(`${lowCtrHighImp.length} queries have >50 impressions but <2% CTR — attempting automated title tweaks`);
    
    // Report only. Automatically prefixing titles with "[Updated]"/"(Working)" and
    // bumping dateModified without changing content are fake-freshness signals that
    // Google's spam policies call out; those auto-"fixes" have been retired.
    for (const r of lowCtrHighImp.slice(0, 10)) {
      issues.push(`Low CTR: "${r.keys[0]}" on ${r.keys[1]} (${r.impressions} impressions, ${(r.ctr * 100).toFixed(1)}% CTR) — rewrite title/description by hand`);
    }
  }

  // Queries ranking poorly
  const badPosition = currentRows.filter(r => r.position > BAD_POSITION_THRESHOLD && r.impressions > 10);
  if (badPosition.length > 0) {
    issues.push(`${badPosition.length} queries ranking past position ${BAD_POSITION_THRESHOLD} with >10 impressions`);
  }

  // Meta description check
  if (fs.existsSync(INDEX_HTML_PATH)) {
    const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
    const metaMatch = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
    if (!metaMatch || metaMatch[1].length < 120) {
      issues.push('Homepage meta description is missing or too short (<120 chars)');
      if (fixHomepageMetaDescription(['meta_desc_too_short'])) {
        fixes.push('Updated homepage meta description to 140+ chars with non-branded keywords');
      }
    }
  }

  // Title tag check
  const titleFixed = fixHomepageTitleTag(currentRows);
  if (titleFixed) {
    fixes.push('Updated homepage <title> tag to include non-branded keyword modifiers');
  }

  // Blog canonical check
  const missingCanonicals = checkBlogCanonicals();
  if (missingCanonicals.length > 0) {
    issues.push(`${missingCanonicals.length} blog posts missing canonical tags: ${missingCanonicals.join(', ')}`);
    const fixedCount = fixBlogCanonicals(missingCanonicals);
    if (fixedCount > 0) {
      fixes.push(`Injected canonical tags into ${fixedCount} blog posts`);
    }
  }

  // Blog meta description freshness refresh
  const blogDir = path.join(__dirname, '..', 'blog');
  const allBlogFiles = fs.existsSync(blogDir)
    ? fs.readdirSync(blogDir).filter(f => f.endsWith('.html') && f !== 'index.html')
    : [];
  const metaFixed = fixBlogMetaDescriptions(allBlogFiles);
  if (metaFixed > 0) {
    fixes.push(`Refreshed meta descriptions in ${metaFixed} blog posts with ${YEAR} year signal`);
  }

  // Detect non-branded keyword opportunities
  const opportunities = detectOpportunities(currentRows);
  if (opportunities.length > 0) {
    issues.push(`${opportunities.length} non-branded keyword opportunities detected — top: "${opportunities[0].query}" (pos ${opportunities[0].position.toFixed(1)}, ${opportunities[0].impressions} impressions)`);
  }

  // Regenerate sitemaps - DISABLED
  // We now rely on the Cloudflare Worker to dynamically generate sitemaps
  // if (!DRY_RUN) {
  //   const sitemapUpdated = await regenerateSitemaps();
  //   if (sitemapUpdated) {
  //     fixes.push('Regenerated sitemap-index.xml, sitemap-blog.xml, sitemap-main.xml with fresh lastmod dates');
  //   }
  // }

  // Gitignore check
  const gitignoreFixed = fixGitignore();
  if (gitignoreFixed) {
    fixes.push('Added gsc-credentials.json and fetch-gsc.js to .gitignore to prevent secret leakage');
  }

  // ── 5. IndexNow ping for top pages that changed
  if (!DRY_RUN && fixes.length > 0) {
    const urlsToReindex = [
      'https://hentaivault.me/',
      'https://hentaivault.me/blog/',
      'https://hentaivault.me/category/',
    ];
    const status = await pingIndexNow(urlsToReindex);
    if (status === 200 || status === 202) {
      fixes.push(`Pinged IndexNow (Bing) for ${urlsToReindex.length} updated pages — status ${status}`);
    }
  }

  // ── 6. Write status report
  const runDate = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const reportMd = buildReport({
    runDate,
    currentMetrics: cur,
    prevMetrics: prev,
    issues,
    fixes,
    rawRows: currentRows,
    opportunities,
  });

  const reportsDir = path.join(__dirname, '..', 'reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

  if (!DRY_RUN) {
    fs.writeFileSync(REPORT_PATH, reportMd, 'utf8');
    const dated = path.join(reportsDir, `seo-${new Date().toISOString().split('T')[0]}.md`);
    fs.writeFileSync(dated, reportMd, 'utf8');
    console.log(`\n📄 Report written to: ${REPORT_PATH}`);
  } else {
    console.log('\n--- DRY RUN REPORT PREVIEW ---\n');
    console.log(reportMd);
  }

  // ── 7. Summary output
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📊 Clicks (7d): ${cur.clicks}  |  Impressions: ${cur.impressions}`);
  console.log(`⚠️  Issues: ${issues.length}  |  🔧 Fixes applied: ${fixes.length}`);
  if (issues.length > 0) {
    console.log('\nIssues:');
    issues.forEach(i => console.log(`  - ${i}`));
  }
  if (fixes.length > 0) {
    console.log('\nFixes:');
    fixes.forEach(f => console.log(`  ✅ ${f}`));
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Emit GitHub Actions warning annotation if traffic dropped significantly
  if (issues.some(i => i.includes('dropped') && parseInt(i.match(/\d+/)?.[0]) > 30)) {
    console.log('::warning title=SEO Traffic Drop::Clicks or impressions dropped by >30% vs last week.');
  }
}

main().catch(err => {
  console.error('Fatal error in seo-autofix:', err);
  process.exit(1);
});
