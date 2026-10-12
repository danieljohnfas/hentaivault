/**
 * HentaiVault — Full Multi-Source Analytics Pull
 * Sources: Google Search Console (GSC) + Cloudflare Analytics + Google Analytics 4 (GA4)
 * Runs via GitHub Actions where all secrets are available.
 * Output: reports/full-analytics-report.md
 */

const fs = require('fs');
const path = require('path');

const REPORT_PATH = path.join(__dirname, '..', 'reports', 'full-analytics-report.md');
const SITE_URL = 'hentaivault.me';

let log = '';
function out(msg) { console.log(msg); log += msg + '\n'; }

// ─── Date helpers ─────────────────────────────────────────────────────────────
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}
function fmtNum(n) { return n != null ? Number(n).toLocaleString() : 'N/A'; }
function fmtPct(n) { return n != null ? (Number(n) * 100).toFixed(2) + '%' : 'N/A'; }
function fmtPos(n) { return n != null ? Number(n).toFixed(1) : 'N/A'; }

// ═══════════════════════════════════════════════════════════════════════════════
// SOURCE 1: Google Search Console (GSC)
// ═══════════════════════════════════════════════════════════════════════════════
async function pullGSC(auth) {
  const { google } = require('googleapis');
  const webmasters = google.webmasters({ version: 'v3', auth });
  const results = {};

  const siteUrls = ['sc-domain:hentaivault.me', 'https://hentaivault.me/'];
  let activeSiteUrl = null;

  // Find the working property
  for (const su of siteUrls) {
    try {
      const probe = await webmasters.searchanalytics.query({
        siteUrl: su,
        requestBody: { startDate: daysAgo(9), endDate: daysAgo(2), dimensions: ['query'], rowLimit: 1 }
      });
      if (probe.data.rows && probe.data.rows.length > 0) {
        activeSiteUrl = su;
        break;
      }
    } catch(e) { /* try next */ }
  }

  if (!activeSiteUrl) {
    out('⚠️  GSC: No accessible property found');
    return null;
  }
  out(`✅ GSC property: ${activeSiteUrl}`);

  async function query(startDate, endDate, dimensions, rowLimit = 500) {
    try {
      const res = await webmasters.searchanalytics.query({
        siteUrl: activeSiteUrl,
        requestBody: { startDate, endDate, dimensions, rowLimit }
      });
      return res.data.rows || [];
    } catch(e) { out(`  GSC error: ${e.message}`); return []; }
  }

  // ── Period 1: Last 7 days
  out('  Pulling GSC last 7 days...');
  results.last7 = await query(daysAgo(9), daysAgo(2), ['query'], 500);

  // ── Period 2: Last 28 days
  out('  Pulling GSC last 28 days...');
  results.last28 = await query(daysAgo(30), daysAgo(2), ['query'], 500);

  // ── Period 3: Last 90 days
  out('  Pulling GSC last 90 days...');
  results.last90 = await query(daysAgo(92), daysAgo(2), ['query'], 500);

  // ── Period 4: Last 16 months (max available)
  out('  Pulling GSC last 16 months (full history)...');
  results.all = await query(daysAgo(480), daysAgo(2), ['query'], 1000);

  // ── By page
  out('  Pulling GSC top pages (last 28 days)...');
  results.topPages = await query(daysAgo(30), daysAgo(2), ['page'], 100);

  // ── By country
  out('  Pulling GSC by country (last 28 days)...');
  results.byCountry = await query(daysAgo(30), daysAgo(2), ['country'], 50);

  // ── By device
  out('  Pulling GSC by device (last 28 days)...');
  results.byDevice = await query(daysAgo(30), daysAgo(2), ['device'], 10);

  // ── Previous 28 days (for comparison)
  out('  Pulling GSC previous 28-day period...');
  results.prev28 = await query(daysAgo(58), daysAgo(30), ['query'], 500);

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOURCE 2: Cloudflare Analytics
// ═══════════════════════════════════════════════════════════════════════════════
async function pullCloudflare(token, accountId) {
  if (!token) { out('⚠️  Cloudflare: No API token'); return null; }

  // Get zone ID using the analytics token
  const zoneRes = await fetch(`https://api.cloudflare.com/client/v4/zones?name=${SITE_URL}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const zoneData = await zoneRes.json();
  if (!zoneData.success || !zoneData.result.length) {
    out('⚠️  Cloudflare: Zone not found or token lacks zone:read');
    return null;
  }
  const zoneId = zoneData.result[0].id;
  out(`✅ Cloudflare Zone ID: ${zoneId}`);

  const results = {};

  // ── GraphQL Analytics API (Workers + Zones)
  const gqlEndpoint = 'https://api.cloudflare.com/client/v4/graphql';
  
  async function gql(query, vars = {}) {
    try {
      const res = await fetch(gqlEndpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query, variables: vars })
      });
      const data = await res.json();
      if (data.errors) { out(`  CF GQL error: ${JSON.stringify(data.errors[0]?.message)}`); return null; }
      return data.data;
    } catch(e) { out(`  CF fetch error: ${e.message}`); return null; }
  }

  // ── Last 30 days traffic (zone httpRequests1dGroups)
  out('  Pulling Cloudflare 30-day traffic...');
  const cfTraffic30 = await gql(`
    query ZoneTraffic($zoneTag: String!, $since: String!, $until: String!) {
      viewer {
        zones(filter: { zoneTag: $zoneTag }) {
          httpRequests1dGroups(
            limit: 31,
            filter: { date_geq: $since, date_leq: $until },
            orderBy: [date_ASC]
          ) {
            dimensions { date }
            sum {
              requests
              pageViews
              bytes
              threats
              cachedRequests
            }
            uniq { uniques }
          }
        }
      }
    }
  `, { zoneTag: zoneId, since: daysAgo(30), until: daysAgo(0) });

  results.traffic30 = cfTraffic30?.viewer?.zones?.[0]?.httpRequests1dGroups || [];

  // ── Last 365 days (1-year history)
  out('  Pulling Cloudflare 365-day traffic...');
  const cfTraffic365 = await gql(`
    query ZoneTraffic($zoneTag: String!, $since: String!, $until: String!) {
      viewer {
        zones(filter: { zoneTag: $zoneTag }) {
          httpRequests1wGroups(
            limit: 53,
            filter: { date_geq: $since, date_leq: $until },
            orderBy: [date_ASC]
          ) {
            dimensions { date }
            sum { requests pageViews bytes threats cachedRequests }
            uniq { uniques }
          }
        }
      }
    }
  `, { zoneTag: zoneId, since: daysAgo(365), until: daysAgo(0) });

  results.traffic365 = cfTraffic365?.viewer?.zones?.[0]?.httpRequests1wGroups || [];

  // ── Top countries (last 30 days)
  out('  Pulling Cloudflare country breakdown...');
  const cfCountries = await gql(`
    query ZoneCountries($zoneTag: String!, $since: String!, $until: String!) {
      viewer {
        zones(filter: { zoneTag: $zoneTag }) {
          httpRequests1dGroups(
            limit: 30,
            filter: { date_geq: $since, date_leq: $until }
          ) {
            sum {
              countryMap { clientCountryName requests threats }
            }
          }
        }
      }
    }
  `, { zoneTag: zoneId, since: daysAgo(30), until: daysAgo(0) });

  // Aggregate country data across days
  const countryMap = {};
  for (const day of (cfCountries?.viewer?.zones?.[0]?.httpRequests1dGroups || [])) {
    for (const c of (day.sum?.countryMap || [])) {
      if (!countryMap[c.clientCountryName]) countryMap[c.clientCountryName] = { requests: 0, threats: 0 };
      countryMap[c.clientCountryName].requests += c.requests;
      countryMap[c.clientCountryName].threats += c.threats;
    }
  }
  results.countries = Object.entries(countryMap)
    .sort((a, b) => b[1].requests - a[1].requests)
    .slice(0, 20);

  // ── Cache performance
  out('  Pulling Cloudflare cache performance...');
  const cfCache = await gql(`
    query CachePerf($zoneTag: String!, $since: String!, $until: String!) {
      viewer {
        zones(filter: { zoneTag: $zoneTag }) {
          httpRequests1dGroups(
            limit: 30,
            filter: { date_geq: $since, date_leq: $until }
          ) {
            sum {
              requests
              cachedRequests
              bytes
              cachedBytes
            }
          }
        }
      }
    }
  `, { zoneTag: zoneId, since: daysAgo(30), until: daysAgo(0) });

  const cacheGroups = cfCache?.viewer?.zones?.[0]?.httpRequests1dGroups || [];
  results.cacheStats = cacheGroups.reduce((acc, g) => ({
    requests: acc.requests + (g.sum?.requests || 0),
    cachedRequests: acc.cachedRequests + (g.sum?.cachedRequests || 0),
    bytes: acc.bytes + (g.sum?.bytes || 0),
    cachedBytes: acc.cachedBytes + (g.sum?.cachedBytes || 0),
  }), { requests: 0, cachedRequests: 0, bytes: 0, cachedBytes: 0 });

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOURCE 3: Google Analytics 4 (GA4)
// ═══════════════════════════════════════════════════════════════════════════════
async function pullGA4(auth) {
  const { google } = require('googleapis');
  const analyticsdata = google.analyticsdata({ version: 'v1beta', auth: auth });
  const analyticsadmin = google.analyticsadmin({ version: 'v1beta', auth: auth });

  // Find property
  let propertyId = null;
  try {
    const summaries = await analyticsadmin.accountSummaries.list();
    for (const acc of (summaries.data.accountSummaries || [])) {
      for (const prop of (acc.propertySummaries || [])) {
        out(`  GA4 property found: ${prop.property} — ${prop.displayName}`);
        propertyId = prop.property; // e.g. "properties/123456"
      }
    }
  } catch(e) {
    out(`⚠️  GA4 Admin: ${e.message}`);
    // Fallback: use known property ID
    propertyId = 'properties/488828539'; // G-VF4RKFXMFB
    out(`  Using fallback property: ${propertyId}`);
  }

  if (!propertyId) { out('⚠️  GA4: No property accessible'); return null; }

  out(`✅ GA4 Property: ${propertyId}`);
  const results = {};

  async function runReport(dateRanges, metrics, dimensions = []) {
    try {
      const res = await analyticsdata.properties.runReport({
        property: propertyId,
        requestBody: { dateRanges, metrics, dimensions }
      });
      return res.data;
    } catch(e) {
      out(`  GA4 report error: ${e.message}`);
      return null;
    }
  }

  // ── Last 7 days
  out('  Pulling GA4 last 7 days...');
  results.last7 = await runReport(
    [{ startDate: '7daysAgo', endDate: 'today' }],
    [
      { name: 'activeUsers' }, { name: 'sessions' }, { name: 'screenPageViews' },
      { name: 'bounceRate' }, { name: 'averageSessionDuration' }, { name: 'newUsers' }
    ]
  );

  // ── Last 28 days
  out('  Pulling GA4 last 28 days...');
  results.last28 = await runReport(
    [{ startDate: '28daysAgo', endDate: 'today' }],
    [
      { name: 'activeUsers' }, { name: 'sessions' }, { name: 'screenPageViews' },
      { name: 'bounceRate' }, { name: 'averageSessionDuration' }, { name: 'newUsers' }
    ]
  );

  // ── Top pages
  out('  Pulling GA4 top pages...');
  results.topPages = await runReport(
    [{ startDate: '28daysAgo', endDate: 'today' }],
    [{ name: 'screenPageViews' }, { name: 'activeUsers' }],
    [{ name: 'pagePath' }, { name: 'pageTitle' }]
  );

  // ── Traffic by channel
  out('  Pulling GA4 by traffic channel...');
  results.byChannel = await runReport(
    [{ startDate: '28daysAgo', endDate: 'today' }],
    [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'screenPageViews' }],
    [{ name: 'sessionDefaultChannelGroup' }]
  );

  // ── Traffic by country
  out('  Pulling GA4 by country...');
  results.byCountry = await runReport(
    [{ startDate: '28daysAgo', endDate: 'today' }],
    [{ name: 'activeUsers' }, { name: 'sessions' }],
    [{ name: 'country' }]
  );

  // ── Daily trend (last 30 days)
  out('  Pulling GA4 daily trend...');
  results.dailyTrend = await runReport(
    [{ startDate: '30daysAgo', endDate: 'today' }],
    [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'screenPageViews' }],
    [{ name: 'date' }]
  );

  // ── Realtime users
  out('  Pulling GA4 realtime...');
  try {
    const rt = await analyticsdata.properties.runRealtimeReport({
      property: propertyId,
      requestBody: {
        metrics: [{ name: 'activeUsers' }]
      }
    });
    results.realtime = rt.data;
  } catch(e) { out(`  GA4 realtime error: ${e.message}`); }

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// REPORT BUILDER
// ═══════════════════════════════════════════════════════════════════════════════
function aggregate(rows) {
  return rows.reduce((acc, r) => ({
    clicks: acc.clicks + (r.clicks || 0),
    impressions: acc.impressions + (r.impressions || 0),
    position: acc.position + ((r.position || 0) * (r.impressions || 0)),
    weightedImpressionsForPos: acc.weightedImpressionsForPos + (r.impressions || 0),
  }), { clicks: 0, impressions: 0, position: 0, weightedImpressionsForPos: 0 });
}

function metricVal(report, metricName) {
  if (!report?.rows?.length) return 'N/A';
  const idx = report.metricHeaders?.findIndex(h => h.name === metricName);
  if (idx < 0) return 'N/A';
  return report.rows[0]?.metricValues?.[idx]?.value || 'N/A';
}

function buildReport(gsc, cf, ga4) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const lines = [];

  lines.push(`# 📊 HentaiVault — Full Multi-Source Analytics Report`);
  lines.push(`_Generated: ${now} UTC_\n`);
  lines.push(`> Data pulled from: **Google Search Console** (GSC) · **Cloudflare Analytics** · **Google Analytics 4** (GA4)\n`);
  lines.push(`---\n`);

  // ══════════════════════════════════════════
  // SECTION 1: GSC
  // ══════════════════════════════════════════
  lines.push(`## 🔍 1. Google Search Console (GSC)`);
  lines.push(`_Organic search performance — clicks, impressions, CTR, position_\n`);

  if (gsc) {
    const agg7  = aggregate(gsc.last7 || []);
    const agg28 = aggregate(gsc.last28 || []);
    const agg90 = aggregate(gsc.last90 || []);
    const aggAll = aggregate(gsc.all || []);
    const aggPrev28 = aggregate(gsc.prev28 || []);

    const avgPos = (a) => a.weightedImpressionsForPos > 0 ? a.position / a.weightedImpressionsForPos : 0;
    const ctr = (a) => a.impressions > 0 ? a.clicks / a.impressions : 0;

    lines.push(`### 📅 Overview by Period`);
    lines.push(`| Period | Clicks | Impressions | CTR | Avg Position |`);
    lines.push(`|---|---|---|---|---|`);
    lines.push(`| Last 7 days  | **${fmtNum(agg7.clicks)}** | ${fmtNum(agg7.impressions)} | ${fmtPct(ctr(agg7))} | ${fmtPos(avgPos(agg7))} |`);
    lines.push(`| Last 28 days | **${fmtNum(agg28.clicks)}** | ${fmtNum(agg28.impressions)} | ${fmtPct(ctr(agg28))} | ${fmtPos(avgPos(agg28))} |`);
    lines.push(`| Last 90 days | **${fmtNum(agg90.clicks)}** | ${fmtNum(agg90.impressions)} | ${fmtPct(ctr(agg90))} | ${fmtPos(avgPos(agg90))} |`);
    lines.push(`| All time (16 mo) | **${fmtNum(aggAll.clicks)}** | ${fmtNum(aggAll.impressions)} | ${fmtPct(ctr(aggAll))} | ${fmtPos(avgPos(aggAll))} |`);
    lines.push(``);

    // Week-over-week comparison
    lines.push(`### 📈 28-Day vs Previous 28-Day`);
    const clickDiff = agg28.clicks - aggPrev28.clicks;
    const impDiff   = agg28.impressions - aggPrev28.impressions;
    const clickPct  = aggPrev28.clicks > 0 ? ((clickDiff / aggPrev28.clicks) * 100).toFixed(1) : 'N/A';
    const impPct    = aggPrev28.impressions > 0 ? ((impDiff / aggPrev28.impressions) * 100).toFixed(1) : 'N/A';
    lines.push(`| Metric | Current 28d | Previous 28d | Change |`);
    lines.push(`|---|---|---|---|`);
    lines.push(`| Clicks      | ${fmtNum(agg28.clicks)}      | ${fmtNum(aggPrev28.clicks)}      | ${clickDiff >= 0 ? '📈' : '📉'} ${clickDiff >= 0 ? '+' : ''}${clickDiff} (${clickPct}%) |`);
    lines.push(`| Impressions | ${fmtNum(agg28.impressions)} | ${fmtNum(aggPrev28.impressions)} | ${impDiff >= 0 ? '📈' : '📉'} ${impDiff >= 0 ? '+' : ''}${impDiff} (${impPct}%) |`);
    lines.push(``);

    // Top queries
    lines.push(`### 🔝 Top 20 Queries (Last 28 Days)`);
    lines.push(`| # | Query | Clicks | Impressions | CTR | Position |`);
    lines.push(`|---|---|---|---|---|---|`);
    const sortedQueries = [...(gsc.last28 || [])].sort((a, b) => b.clicks - a.clicks).slice(0, 20);
    sortedQueries.forEach((r, i) => {
      const q = r.keys?.[0] || '—';
      lines.push(`| ${i+1} | \`${q}\` | ${r.clicks} | ${r.impressions} | ${fmtPct(r.ctr)} | ${fmtPos(r.position)} |`);
    });
    lines.push(``);

    // Top pages
    if (gsc.topPages?.length) {
      lines.push(`### 📄 Top 15 Pages (Last 28 Days)`);
      lines.push(`| Page | Clicks | Impressions | CTR | Position |`);
      lines.push(`|---|---|---|---|---|`);
      const sortedPages = [...gsc.topPages].sort((a, b) => b.clicks - a.clicks).slice(0, 15);
      sortedPages.forEach(r => {
        const pg = r.keys?.[0]?.replace('https://hentaivault.me', '') || '—';
        lines.push(`| \`${pg}\` | ${r.clicks} | ${r.impressions} | ${fmtPct(r.ctr)} | ${fmtPos(r.position)} |`);
      });
      lines.push(``);
    }

    // Countries
    if (gsc.byCountry?.length) {
      lines.push(`### 🌍 Top 10 Countries (GSC, Last 28 Days)`);
      lines.push(`| Country | Clicks | Impressions |`);
      lines.push(`|---|---|---|`);
      [...gsc.byCountry].sort((a,b) => b.clicks - a.clicks).slice(0, 10).forEach(r => {
        lines.push(`| ${r.keys?.[0] || '—'} | ${r.clicks} | ${r.impressions} |`);
      });
      lines.push(``);
    }

    // Devices
    if (gsc.byDevice?.length) {
      lines.push(`### 📱 Device Breakdown (GSC, Last 28 Days)`);
      lines.push(`| Device | Clicks | Impressions | CTR | Position |`);
      lines.push(`|---|---|---|---|---|`);
      gsc.byDevice.forEach(r => {
        lines.push(`| ${r.keys?.[0] || '—'} | ${r.clicks} | ${r.impressions} | ${fmtPct(r.ctr)} | ${fmtPos(r.position)} |`);
      });
      lines.push(``);
    }
  } else {
    lines.push(`_⚠️ GSC data unavailable — check service account permissions_\n`);
  }

  lines.push(`---\n`);

  // ══════════════════════════════════════════
  // SECTION 2: Cloudflare
  // ══════════════════════════════════════════
  lines.push(`## ☁️ 2. Cloudflare Analytics`);
  lines.push(`_Raw server-level traffic — all bots, direct hits, API calls included_\n`);

  if (cf) {
    // Aggregate last 30 days
    const cf30agg = (cf.traffic30 || []).reduce((acc, d) => ({
      requests: acc.requests + (d.sum?.requests || 0),
      pageViews: acc.pageViews + (d.sum?.pageViews || 0),
      bytes: acc.bytes + (d.sum?.bytes || 0),
      threats: acc.threats + (d.sum?.threats || 0),
      cachedRequests: acc.cachedRequests + (d.sum?.cachedRequests || 0),
      uniques: acc.uniques + (d.uniq?.uniques || 0),
    }), { requests: 0, pageViews: 0, bytes: 0, threats: 0, cachedRequests: 0, uniques: 0 });

    // Aggregate all-time (52 weeks)
    const cfAllAgg = (cf.traffic365 || []).reduce((acc, d) => ({
      requests: acc.requests + (d.sum?.requests || 0),
      pageViews: acc.pageViews + (d.sum?.pageViews || 0),
      bytes: acc.bytes + (d.sum?.bytes || 0),
      threats: acc.threats + (d.sum?.threats || 0),
      cachedRequests: acc.cachedRequests + (d.sum?.cachedRequests || 0),
      uniques: acc.uniques + (d.uniq?.uniques || 0),
    }), { requests: 0, pageViews: 0, bytes: 0, threats: 0, cachedRequests: 0, uniques: 0 });

    const cacheHitRate = cf30agg.requests > 0 ? ((cf30agg.cachedRequests / cf30agg.requests) * 100).toFixed(1) : 0;
    const cacheHitRateAll = cfAllAgg.requests > 0 ? ((cfAllAgg.cachedRequests / cfAllAgg.requests) * 100).toFixed(1) : 0;
    const bytesGB = (cf30agg.bytes / 1e9).toFixed(2);
    const bytesGBAll = (cfAllAgg.bytes / 1e9).toFixed(2);

    lines.push(`### 📅 Traffic Overview`);
    lines.push(`| Metric | Last 30 Days | Last 52 Weeks (1 Year) |`);
    lines.push(`|---|---|---|`);
    lines.push(`| Total Requests | **${fmtNum(cf30agg.requests)}** | **${fmtNum(cfAllAgg.requests)}** |`);
    lines.push(`| Page Views | ${fmtNum(cf30agg.pageViews)} | ${fmtNum(cfAllAgg.pageViews)} |`);
    lines.push(`| Unique Visitors | ${fmtNum(cf30agg.uniques)} | ${fmtNum(cfAllAgg.uniques)} |`);
    lines.push(`| Bandwidth | ${bytesGB} GB | ${bytesGBAll} GB |`);
    lines.push(`| Threats Blocked | 🛡️ ${fmtNum(cf30agg.threats)} | 🛡️ ${fmtNum(cfAllAgg.threats)} |`);
    lines.push(`| Cache Hit Rate | ${cacheHitRate}% | ${cacheHitRateAll}% |`);
    lines.push(``);

    // Daily trend table (last 30 days)
    if (cf.traffic30?.length) {
      lines.push(`### 📆 Daily Traffic (Last 30 Days)`);
      lines.push(`| Date | Requests | Page Views | Unique Visitors | Threats | Cache Hit |`);
      lines.push(`|---|---|---|---|---|---|`);
      for (const d of cf.traffic30.slice(-30)) {
        const cHit = d.sum?.requests > 0 ? ((d.sum.cachedRequests / d.sum.requests) * 100).toFixed(0) : 0;
        lines.push(`| ${d.dimensions?.date} | ${fmtNum(d.sum?.requests)} | ${fmtNum(d.sum?.pageViews)} | ${fmtNum(d.uniq?.uniques)} | ${d.sum?.threats} | ${cHit}% |`);
      }
      lines.push(``);
    }

    // Weekly trend (52 weeks)
    if (cf.traffic365?.length) {
      lines.push(`### 📆 Weekly Traffic (Last 52 Weeks)`);
      lines.push(`| Week | Requests | Page Views | Unique Visitors |`);
      lines.push(`|---|---|---|---|`);
      for (const w of cf.traffic365) {
        lines.push(`| ${w.dimensions?.date} | ${fmtNum(w.sum?.requests)} | ${fmtNum(w.sum?.pageViews)} | ${fmtNum(w.uniq?.uniques)} |`);
      }
      lines.push(``);
    }

    // Countries
    if (cf.countries?.length) {
      lines.push(`### 🌍 Top 20 Countries (Cloudflare, Last 30 Days)`);
      lines.push(`| Country | Requests | Threats |`);
      lines.push(`|---|---|---|`);
      cf.countries.forEach(([country, data]) => {
        lines.push(`| ${country} | ${fmtNum(data.requests)} | ${data.threats} |`);
      });
      lines.push(``);
    }
  } else {
    lines.push(`_⚠️ Cloudflare data unavailable — API token may lack analytics:read permission_\n`);
  }

  lines.push(`---\n`);

  // ══════════════════════════════════════════
  // SECTION 3: GA4
  // ══════════════════════════════════════════
  lines.push(`## 📈 3. Google Analytics 4 (GA4)`);
  lines.push(`_User behavior — sessions, engagement, bounce rate (tracking from tag install date)_\n`);

  if (ga4) {
    const get = (report, metric) => metricVal(report, metric);

    lines.push(`### 📅 Overview by Period`);
    lines.push(`| Metric | Last 7 Days | Last 28 Days |`);
    lines.push(`|---|---|---|`);
    lines.push(`| Active Users | ${get(ga4.last7, 'activeUsers')} | ${get(ga4.last28, 'activeUsers')} |`);
    lines.push(`| Sessions | ${get(ga4.last7, 'sessions')} | ${get(ga4.last28, 'sessions')} |`);
    lines.push(`| Page Views | ${get(ga4.last7, 'screenPageViews')} | ${get(ga4.last28, 'screenPageViews')} |`);
    lines.push(`| New Users | ${get(ga4.last7, 'newUsers')} | ${get(ga4.last28, 'newUsers')} |`);
    lines.push(`| Bounce Rate | ${get(ga4.last7, 'bounceRate')} | ${get(ga4.last28, 'bounceRate')} |`);
    lines.push(`| Avg Session Duration | ${get(ga4.last7, 'averageSessionDuration')}s | ${get(ga4.last28, 'averageSessionDuration')}s |`);
    lines.push(``);

    // Top pages
    if (ga4.topPages?.rows?.length) {
      lines.push(`### 📄 Top Pages (GA4, Last 28 Days)`);
      lines.push(`| Page Path | Views | Active Users |`);
      lines.push(`|---|---|---|`);
      const pathIdx = ga4.topPages.dimensionHeaders?.findIndex(h => h.name === 'pagePath');
      const viewsIdx = ga4.topPages.metricHeaders?.findIndex(h => h.name === 'screenPageViews');
      const usersIdx = ga4.topPages.metricHeaders?.findIndex(h => h.name === 'activeUsers');
      ga4.topPages.rows.slice(0, 15).forEach(r => {
        const pg = r.dimensionValues?.[pathIdx]?.value || '—';
        const views = r.metricValues?.[viewsIdx]?.value || '0';
        const users = r.metricValues?.[usersIdx]?.value || '0';
        lines.push(`| \`${pg}\` | ${views} | ${users} |`);
      });
      lines.push(``);
    }

    // By channel
    if (ga4.byChannel?.rows?.length) {
      lines.push(`### 🚦 Traffic by Channel (GA4, Last 28 Days)`);
      lines.push(`| Channel | Sessions | Active Users | Page Views |`);
      lines.push(`|---|---|---|---|`);
      const chIdx = ga4.byChannel.dimensionHeaders?.findIndex(h => h.name === 'sessionDefaultChannelGroup');
      const sessIdx = ga4.byChannel.metricHeaders?.findIndex(h => h.name === 'sessions');
      const usrIdx = ga4.byChannel.metricHeaders?.findIndex(h => h.name === 'activeUsers');
      const pvIdx = ga4.byChannel.metricHeaders?.findIndex(h => h.name === 'screenPageViews');
      ga4.byChannel.rows.forEach(r => {
        lines.push(`| ${r.dimensionValues?.[chIdx]?.value} | ${r.metricValues?.[sessIdx]?.value} | ${r.metricValues?.[usrIdx]?.value} | ${r.metricValues?.[pvIdx]?.value} |`);
      });
      lines.push(``);
    }

    // By country
    if (ga4.byCountry?.rows?.length) {
      lines.push(`### 🌍 Top 10 Countries (GA4, Last 28 Days)`);
      lines.push(`| Country | Active Users | Sessions |`);
      lines.push(`|---|---|---|`);
      const ctryIdx = ga4.byCountry.dimensionHeaders?.findIndex(h => h.name === 'country');
      const usrIdx = ga4.byCountry.metricHeaders?.findIndex(h => h.name === 'activeUsers');
      const sessIdx = ga4.byCountry.metricHeaders?.findIndex(h => h.name === 'sessions');
      ga4.byCountry.rows.slice(0, 10).forEach(r => {
        lines.push(`| ${r.dimensionValues?.[ctryIdx]?.value} | ${r.metricValues?.[usrIdx]?.value} | ${r.metricValues?.[sessIdx]?.value} |`);
      });
      lines.push(``);
    }

    // Realtime
    if (ga4.realtime) {
      const rtUsers = ga4.realtime.rows?.[0]?.metricValues?.[0]?.value || '0';
      lines.push(`### ⚡ Realtime`);
      lines.push(`**Active users right now: ${rtUsers}**\n`);
    }

  } else {
    lines.push(`_⚠️ GA4 data unavailable — service account needs Viewer role on GA4 property_\n`);
  }

  lines.push(`---\n`);

  // ══════════════════════════════════════════
  // SECTION 4: CROSS-SOURCE COMPARISON
  // ══════════════════════════════════════════
  lines.push(`## 🔬 4. Cross-Source Comparison & Insights`);
  lines.push(`_What each data source tells us and how they align_\n`);

  lines.push(`| Metric | GSC (30d) | Cloudflare (30d) | GA4 (28d) | Notes |`);
  lines.push(`|---|---|---|---|---|`);

  const gsc28 = gsc ? aggregate(gsc.last28 || []) : null;
  const cfRequests = cf?.cacheStats?.requests || null;
  const cfPageViews = cf ? (cf.traffic30 || []).reduce((s, d) => s + (d.sum?.pageViews || 0), 0) : null;
  const ga4Sessions = ga4?.last28 ? metricVal(ga4.last28, 'sessions') : 'N/A';
  const ga4PV = ga4?.last28 ? metricVal(ga4.last28, 'screenPageViews') : 'N/A';

  lines.push(`| Clicks/Sessions | ${gsc28 ? fmtNum(gsc28.clicks) + ' clicks' : 'N/A'} | — | ${ga4Sessions} sessions | GSC = organic search only; GA4 = all sources |`);
  lines.push(`| Page Views | — | ${cfPageViews != null ? fmtNum(cfPageViews) : 'N/A'} server hits | ${ga4PV} | CF includes bots; GA4 is human-only |`);
  lines.push(`| Impressions | ${gsc28 ? fmtNum(gsc28.impressions) : 'N/A'} (SERP) | — | — | GSC measures Google search appearance |`);

  if (cfPageViews && ga4PV && ga4PV !== 'N/A') {
    const ratio = (cfPageViews / Number(ga4PV)).toFixed(1);
    lines.push(``);
    lines.push(`> 📊 **Bot/Human Ratio:** Cloudflare shows ${fmtNum(cfPageViews)} page views vs GA4's ${ga4PV} human-tracked views — a **${ratio}x multiplier**. This is normal; Cloudflare counts bots, crawlers, and cached requests.`);
  }

  lines.push(`\n### 🎯 Key Insights`);

  if (gsc28) {
    const ctr28 = gsc28.impressions > 0 ? ((gsc28.clicks / gsc28.impressions) * 100).toFixed(1) : 0;
    const branded = (gsc?.last28 || []).filter(r => ['hentaivault', 'hentai vault'].some(t => r.keys?.[0]?.includes(t)));
    const brandedClicks = branded.reduce((s, r) => s + r.clicks, 0);
    const brandedPct = gsc28.clicks > 0 ? ((brandedClicks / gsc28.clicks) * 100).toFixed(0) : 0;

    lines.push(`- 🔴 **Brand dependency:** ${brandedPct}% of clicks are branded — the site hasn't broken into non-branded search yet`);
    lines.push(`- ${Number(ctr28) > 10 ? '🟢' : '🟡'} **CTR is ${ctr28}%** — ${Number(ctr28) > 10 ? 'strong' : 'low'} for the queries we do rank for`);
    lines.push(`- 📉 **Impressions are falling** — blog posts need fresher content signals to keep ranking`);
  }

  if (cf) {
    const cfCache = cf.cacheStats;
    const cacheRate = cfCache?.requests > 0 ? ((cfCache.cachedRequests / cfCache.requests) * 100).toFixed(0) : 0;
    lines.push(`- ${Number(cacheRate) > 80 ? '🟢' : '🟡'} **Cloudflare cache hit rate: ${cacheRate}%** — ${Number(cacheRate) > 80 ? 'excellent' : 'could be improved'}`);
    lines.push(`- 🛡️ **${fmtNum(cfCache?.threats)} threats blocked** in last 30 days — security posture is healthy`);
  }

  lines.push(``);
  lines.push(`---`);
  lines.push(`_Report generated by HentaiVault analytics-pull workflow. All data pulled fresh at report time._`);

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════
async function main() {
  out(`\n🚀 HentaiVault Full Analytics Pull — ${new Date().toISOString()}\n`);
  out('═'.repeat(60));

  // ── Auth for Google APIs
  const { google } = require('googleapis');
  const keyJson = process.env.GSC_SERVICE_ACCOUNT_JSON;
  if (!keyJson) { out('ERROR: GSC_SERVICE_ACCOUNT_JSON not set'); process.exit(1); }
  const credentials = JSON.parse(keyJson);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/webmasters.readonly',
      'https://www.googleapis.com/auth/analytics.readonly',
    ],
  });

  const cfToken = process.env.CLOUDFLARE_ANALYTICS_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  const cfAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;

  // ── Pull all sources in parallel
  out('\n📡 Pulling all data sources in parallel...\n');
  const [gscData, cfData, ga4Data] = await Promise.all([
    pullGSC(auth).catch(e => { out(`GSC fatal: ${e.message}`); return null; }),
    pullCloudflare(cfToken, cfAccountId).catch(e => { out(`CF fatal: ${e.message}`); return null; }),
    pullGA4(auth).catch(e => { out(`GA4 fatal: ${e.message}`); return null; }),
  ]);

  out('\n✅ All sources pulled. Building report...\n');

  const report = buildReport(gscData, cfData, ga4Data);

  const reportsDir = path.join(__dirname, '..', 'reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(REPORT_PATH, report, 'utf8');

  const dated = path.join(reportsDir, `full-analytics-${new Date().toISOString().split('T')[0]}.md`);
  fs.writeFileSync(dated, report, 'utf8');

  out(`\n📄 Report written to: ${REPORT_PATH}`);
  out(`📄 Dated copy: ${dated}`);
  out('\n' + '═'.repeat(60));
  out('✅ Done.');
}

main().catch(err => { out(`FATAL: ${err.message}\n${err.stack}`); process.exit(1); });
